import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {Fleet, describe} from '../src/fleet.js';
import {Controller} from '../src/controller.js';
import {createApi} from '../src/http-api.js';
import {IDLE} from '../src/protocol.js';

function raw(port, productId = 2, address = port + 10) { return {vendorId: 0x1130, productId, bus:'001', ports:[port], address}; }
function setup(count = 3, wait = async () => sleep(1)) {
  const inventory = Array.from({length:count}, (_,i)=>raw(i+1, i%2 ? 2 : 1));
  const fleet = new Fleet({discover:async()=>inventory, makeController:(device, descriptor)=>new Controller({
    connected:false, writes:[], async connect(){this.connected=true;},
    async send(state){this.writes.push({...state});}, async close(){this.connected=false;},
    info(){return {connected:this.connected, ...descriptor};},
  }, {cooldownMs:0, wait})});
  return {fleet,inventory};
}

test('Discovery supports both product ids and arbitrary device count; ids survive address changes', async t => {
  const {fleet,inventory}=setup();t.after(()=>fleet.close());await fleet.refresh();
  assert.equal(fleet.status().connectedCount,3);
  assert.equal(describe(raw(1,1,10)).id,describe(raw(1,1,99)).id);
  assert.equal(describe(raw(1,3)),null);
  const id=describe(inventory[1]).id;
  inventory.splice(1,1);await fleet.refresh();
  assert.equal(fleet.status().connectedCount,2);
  await assert.rejects(fleet.getController(id),e=>e.status===404);
  inventory.push(raw(2,2,55));await fleet.refresh();
  assert.equal(fleet.status().connectedCount,3);
  assert.equal((await fleet.getController(id)).device.info().address,55);
});

test('All-device dance uses one job id, synchronized start, independent outputs and completion', async t => {
  const {fleet}=setup();t.after(()=>fleet.close());await fleet.refresh();
  const accepted=await fleet.dance();assert.equal(accepted.activeAction.deviceIds.length,3);
  assert.equal(new Set(accepted.devices.map(d=>d.activeAction.id)).size,1);
  await fleet.group.done;
  assert.equal(fleet.status().lastDance.outcome,'completed');
  assert.equal(fleet.status().lastDance.results.length,3);
  for (const e of fleet.entries.values()) {
    assert.deepEqual(e.controller.state,IDLE);
    assert.equal(e.controller.device.writes.filter(s=>s.wings==='up').length,10);
  }
});

test('Concurrent group starts reject the second request without cancelling the first; reset stops every member', async t => {
  const {fleet}=setup(2,sleep);t.after(()=>fleet.close());await fleet.refresh();
  const starts=await Promise.allSettled([fleet.dance(),fleet.dance()]);
  assert.equal(starts.filter(s=>s.status==='fulfilled').length,1);
  assert.equal(starts.find(s=>s.status==='rejected').reason.status,409);
  assert.equal(fleet.status().busy,true);
  await fleet.reset();assert.equal(fleet.status().lastDance.outcome,'cancelled');
  assert.ok(fleet.status().devices.every(d=>!d.busy && d.state.head==='off' && d.state.wings==='idle'));
});

test('One failed startup stops ready members before moving; mid-routine failure preserves per-device outcomes', async t => {
  const {fleet}=setup(2);t.after(()=>fleet.close());await fleet.refresh();
  const entries=[...fleet.entries.values()];
  const original=entries[1].controller.device.send.bind(entries[1].controller.device);
  entries[1].controller.device.send=async state=>{if(state.head==='cyan')throw Error('disconnected');await original(state);};
  await assert.rejects(fleet.dance(),e=>e.status===503 && e.results.length===2);
  assert.equal(entries[0].controller.device.writes.some(s=>s.wings!=='idle'),false);
  assert.ok(fleet.status().devices.every(d=>!d.busy));
  entries[1].controller.device.send=async state=>{if(state.wings==='down')throw Error('lost USB');await original(state);};
  await fleet.dance();await fleet.group.done;
  assert.equal(fleet.status().lastDance.outcome,'failed');
  assert.deepEqual(fleet.status().lastDance.results.map(r=>r.outcome),['completed','failed']);
  assert.deepEqual(entries[0].controller.state,IDLE);
});

test('Authenticated per-device API selects one figure while global endpoints control all', async t => {
  const {fleet}=setup(2,sleep);await fleet.refresh();
  const server=createApi(fleet,{token:'test-token'});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await fleet.close();await new Promise(r=>server.close(r));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={authorization:'Bearer test-token','content-type':'application/json'};
  assert.equal((await fetch(base+'/api/devices')).status,401);
  const inventory=await (await fetch(base+'/api/devices',{headers})).json();assert.equal(inventory.deviceCount,2);
  const id=inventory.devices[0].id;
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await post(`/api/devices/${id}/head`,{color:'green'})).status,200);
  assert.equal(fleet.status().devices[0].state.head,'green');assert.equal(fleet.status().devices[1].state.head,'off');
  assert.equal((await post('/api/dance',{target:'unknown'})).status,400);
  assert.equal((await post(`/api/devices/${id}/dance`,{target:'all'})).status,400);
  const dance=await post('/api/dance',{target:'all'});assert.equal(dance.status,202);
  assert.equal((await dance.json()).activeAction.deviceIds.length,2);
  assert.equal((await post('/api/reset',{})).status,200);
});

test('Unopened USB address zero resolves through Linux sysfs before Docker mapping', () => {
  const d = describe(raw(2, 1, 0), path => {
    assert.equal(path, '/sys/bus/usb/devices/1-2/devnum');
    return '42\n';
  });
  assert.equal(d.address, 42);
  assert.equal(d.id, 'usb-001-2-p0001');
  assert.throws(() => describe(raw(2, 1, 0), () => '0'), /USB address unavailable/);
});
