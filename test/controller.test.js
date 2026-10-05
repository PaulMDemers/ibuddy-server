import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {Controller} from '../src/controller.js';
import {IDLE} from '../src/protocol.js';

export class FakeDevice {
  connected = false;
  writes = [];
  async connect() { this.connected = true; }
  async send(state) { this.writes.push({...state}); }
  async close() { this.connected = false; }
  info() { return {connected: this.connected}; }
}
test('Flapping and turning return both actuators to idle while preserving LEDs', async t => {
  const device = new FakeDevice();
  const c = new Controller(device, {cooldownMs: 0, wait: async () => {}});
  t.after(() => c.close());
  await c.leds({head: 'purple', heart: true}, 10000);
  await c.flap(2, 150);
  assert.deepEqual(device.writes.filter(s => s.wings !== 'idle').map(s => s.wings), ['up', 'down', 'up', 'down']);
  await c.turn('right', 200);
  assert.deepEqual(c.state, {...IDLE, head: 'purple', heart: true});
});
test('Reset interrupts an in-flight motion; concurrent commands and rapid repeat motion are rejected', async t => {
  const device = new FakeDevice();
  const c = new Controller(device);
  t.after(() => c.close());
  const motion = c.turn('left', 400);
  const rejection = assert.rejects(motion, error => error.status === 409);
  await sleep(10);
  assert.throws(() => c.leds({head: 'red'}, 1000), error => error.status === 409);
  const result = await c.reset();
  await rejection;
  assert.deepEqual(c.state, IDLE);
  assert.equal(result.busy, false);
  assert.deepEqual(device.writes.at(-1), IDLE);
  assert.throws(() => c.flap(1, 100), error => error.status === 429);
});
test('An animation failure still attempts to release the actuators', async t => {
  const device = new FakeDevice();
  const original = device.send.bind(device);
  device.send = async s => { if (s.wings === 'down') throw new Error('USB failure'); await original(s); };
  const c = new Controller(device, {wait: async () => {}});
  t.after(() => c.close());
  await assert.rejects(c.flap(1, 100), /USB failure/);
  assert.deepEqual(device.writes.at(-1), IDLE);
  assert.equal(c.status().busy, false);
});
test('LED leases automatically expire and shutdown sends all-off', async () => {
  const device = new FakeDevice();
  const c = new Controller(device);
  await c.leds({head: 'blue', heart: true}, 20);
  await sleep(60);
  assert.deepEqual(c.state, IDLE);
  await c.close();
  assert.deepEqual(device.writes.at(-1), IDLE);
  assert.equal(device.connected, false);
  assert.throws(() => c.turn('left', 50), error => error.status === 503);
});

test('Alert is bounded, rests motors between bursts, reports completion and ends all-off', async t => {
  const device = new FakeDevice(), delays = [];
  const c = new Controller(device, {cooldownMs: 0, wait: async ms => { delays.push(ms); await sleep(1); }});
  t.after(() => c.close());
  const status = await c.alert(5);
  assert.equal(status.busy, true);
  assert.equal(status.activeAction.type, 'alert');
  const action = c.current.promise;
  assert.throws(() => c.flap(1, 100), error => error.status === 409);
  await action;
  assert.equal(delays.reduce((a,b) => a+b, 0), 5000);
  assert.deepEqual(device.writes.at(-1), IDLE);
  assert.equal(c.status().lastAlert.outcome, 'completed');
  assert.equal(c.status().lastAlert.id, status.activeAction.id);
  assert.ok(device.writes.some(s => s.head === 'blue'));
  assert.deepEqual(device.writes.filter(s => s.turn !== 'idle').map(s => s.turn), ['left', 'right']);
});

test('Reset and shutdown cancel an alert; USB failure rejects start and releases controller', async t => {
  const device = new FakeDevice();
  const c = new Controller(device, {cooldownMs: 0});
  t.after(() => c.close());
  await c.alert(30);
  await c.reset();
  assert.equal(c.status().lastAlert.outcome, 'cancelled');
  assert.deepEqual(c.state, IDLE);
  await c.alert(30);
  await c.close();
  assert.equal(c.status().lastAlert.outcome, 'cancelled');
  assert.equal(c.status().busy, false);
  const bad = new Controller({...device, connected: false, async connect() { throw new Error('unplugged'); }});
  await assert.rejects(bad.alert(5), /unplugged/);
  assert.equal(bad.current, null);
  assert.equal(bad.lastAlert.outcome, 'failed');
});
