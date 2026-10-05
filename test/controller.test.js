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
