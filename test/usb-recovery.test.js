import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanUsb, fingerprint, recover, writeMapping} from '../scripts/lib/usb-recovery.js';

const device = (address, generation = '7:9') => ({id: 'usb-1-1-p0001', path: `/dev/bus/usb/001/${String(address).padStart(3,'0')}`, generation});
const container = (devices, id = 'old', running = true) => ({id, running, devices: devices.map(d => ({PathOnHost: d.path, PathInContainer: d.path}))});
function scenario(devices = [device(10)]) {
  const fixture = {devices, container: container(devices), state: {}, now: 100000, status: {busy: false}, applied: [], messages: []};
  fixture.tick = () => recover({...fixture, getStatus: async () => fixture.status,
    save: async state => {fixture.state = structuredClone(state);},
    apply: async devices => {
      fixture.applied.push(structuredClone(devices));
      if (fixture.fail) throw Error('Docker unavailable');
      fixture.container = container(devices, 'new');
      return fixture.container;
    }, log: msg => fixture.messages.push(msg)});
  return fixture;
}

test('USB scan filters vendor/products/interfaces, sorts ports and tracks address plus inode generation', async t => {
  const sysfs = await mkdtemp(join(tmpdir(), 'ibuddy-sysfs-')); t.after(() => rm(sysfs, {recursive:true, force:true}));
  for (const [port, vendor, product, address] of [['1-2','1130','0002',10],['1-1','1130','0001',18],['1-3','1130','0003',20],['1-4','9999','0001',21],['1-1:1.1','1130','0001',18]]) {
    const directory = join(sysfs, port); await mkdir(directory);
    for (const [file, value] of Object.entries({idVendor:vendor,idProduct:product,busnum:1,devnum:address})) await writeFile(join(directory,file), String(value)+'\n');
  }
  await mkdir(join(sysfs,'1-5')); // USB disappears during the scan.
  const devices = await scanUsb({sysfs, nodeStat:async path=>({ino:BigInt(path.endsWith('018')?123:124),rdev:189n,ctimeNs:1000n,isCharacterDevice:()=>true})});
  assert.deepEqual(devices.map(d=>d.path),['/dev/bus/usb/001/018','/dev/bus/usb/001/010']);
  assert.equal(devices[0].generation,'123:189:1000');
  await writeFile(join(sysfs,'1-1/devnum'),'0\n');
  await assert.rejects(scanUsb({sysfs}), /Invalid USB location/);
  await writeFile(join(sysfs,'1-1/devnum'),'18\n');
  await assert.rejects(scanUsb({sysfs, nodeStat:async()=>{throw Object.assign(Error('Permission denied'),{code:'EACCES'});}}), /Permission denied/);
});

test('Changed address debounces then remaps all members; stable scans never restart the container', async () => {
  const f=scenario([device(10),{...device(11),id:'usb-1-2-p0002'}]); await f.tick();
  assert.equal(f.applied.length,0);
  f.devices[0]=device(18);await f.tick();
  assert.equal(f.applied.length,0);
  f.now+=15000;await f.tick();
  assert.equal(f.applied.length,1);assert.equal(f.applied[0].length,2);
  f.now+=15000;await f.tick();assert.equal(f.applied.length,1);
});

test('A reused USB address with a new inode forces recreation despite matching paths', async () => {
  const f=scenario();await f.tick();f.devices=[device(10,'99:9')];await f.tick();
  f.now+=15000;await f.tick();assert.equal(f.applied.length,1);
});

test('Unplug/replug bounce is coalesced; zero figures removes stale mappings and returning devices recover', async () => {
  const f=scenario();await f.tick();f.devices=[];await f.tick();
  f.devices=[device(18)];f.now+=5000;await f.tick();
  f.now+=15000;await f.tick();assert.equal(f.applied.length,1);
  f.devices=[];await f.tick();f.now+=15000;await f.tick();assert.deepEqual(f.applied[1],[]);
  f.devices=[device(25)];await f.tick();f.now+=15000;await f.tick();assert.equal(f.applied.length,3);
});

test('Active routines defer recovery, unreachable API receives a grace period, stopped mismatched API recovers', async () => {
  const f=scenario();await f.tick();f.devices=[device(18)];await f.tick();
  f.status={busy:true};f.now+=15000;await f.tick();assert.equal(f.applied.length,0);
  f.status={busy:false};await f.tick();assert.equal(f.applied.length,1);
  f.devices=[device(20)];await f.tick();f.status=null;f.now+=15000;await f.tick();assert.equal(f.applied.length,1);
  f.now+=60000;await f.tick();assert.equal(f.applied.length,2);
  f.devices=[device(21)];await f.tick();f.container.running=false;f.now+=15000;await f.tick();assert.equal(f.applied.length,3);
});

test('Failed recreation remains pending and retries with backoff; absent/matching stopped containers stay stopped', async () => {
  const f=scenario();await f.tick();f.devices=[device(18)];await f.tick();
  f.fail=true;f.now+=15000;await assert.rejects(f.tick(),/Docker unavailable/);
  f.now+=15000;await f.tick();assert.equal(f.applied.length,1);
  f.fail=false;f.now+=15000;await f.tick();assert.equal(f.applied.length,2);
  f.container.running=false;await f.tick();assert.equal(f.applied.length,2);
  f.container=null;await f.tick();assert.equal(f.applied.length,2);
});

test('Explicit mapping writes replace rather than merge stale nodes and protect the file', async t => {
  const directory=await mkdtemp(join(tmpdir(),'ibuddy-map-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'compose.usb.yaml');
  await writeMapping(path,[device(18)]);await writeMapping(path,[]);
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')).services.api.devices,[]);
  assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal(fingerprint([device(18)]).includes('18'),true);
});

test('A new routine racing the idle check cancels recovery before any Docker mutation', async () => {
  const f=scenario();await f.tick();f.devices=[device(18)];await f.tick();f.now+=15000;
  await recover({...f,getStatus:async()=>({busy:false}),reserve:async()=>false,
    save:async next=>{f.state=next;},apply:async()=>{throw Error('Restart must not happen');},log:()=>{}});
  assert.equal(f.state.lastAttempt,null);
});
