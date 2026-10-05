import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Controller} from '../src/controller.js';
import {createApi} from '../src/http-api.js';

test('HTTP auth, types, bounds and unknown fields block commands before USB writes', async t => {
  const device = {connected: false, writes: [], async connect() { this.connected = true; },
    async send(s) { this.writes.push({...s}); }, async close() {}, info() { return {connected: this.connected}; }};
  const c = new Controller(device, {cooldownMs: 0, wait: async () => {}});
  const server = createApi(c, {token: 'test-token'});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await c.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, input, headers = {}) => fetch(`${base}${path}`, {method: 'POST',
    headers: {'content-type': 'application/json', authorization: 'Bearer test-token', ...headers}, body: JSON.stringify(input)});
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  for (const [path, input] of [['/api/head', {color: ['red']}], ['/api/head', {color: 'ultraviolet'}],
    ['/api/heart', {on: 1}], ['/api/flap', {count: 100}], ['/api/flap', {intervalMs: 0}],
    ['/api/turn', {direction: 'left', durationMs: 401}], ['/api/reset', {raw: 0}],
    ['/api/head', {color: 'red', ttlSeconds: 121}], ['/api/head', null], ['/api/alert', {durationSeconds: 61}], ['/api/alert', {durationSeconds: 4}], ['/api/alert', {durationSeconds: true}], ['/api/alert', {raw: 0}]]) {
    assert.equal((await post(path, input)).status, 400);
  }
  assert.equal((await post('/api/head', {color: 'red'}, {origin: 'http://other.example'})).status, 403);
  assert.equal((await post('/api/head', {color: 'red'}, {origin: 'null'})).status, 403);
  assert.equal((await post('/api/head', {color: 'red'}, {'content-type': 'text/plain'})).status, 415);
  assert.equal((await post('/api/head', {color: 'red', padding: 'a'.repeat(5000)})).status, 413);
  assert.equal(device.writes.length, 0);
  const head = await post('/api/head', {color: 'blue'});
  assert.equal(head.status, 200);
  assert.equal((await head.json()).state.head, 'blue');
  const turn = await post('/api/turn', {direction: 'left', durationMs: 50});
  assert.equal(turn.status, 200);
  assert.equal((await turn.json()).state.turn, 'idle');
  assert.equal((await post('/api/reset', {})).status, 200);
  c.wait = (await import('node:timers/promises')).setTimeout;
  const alert = await post('/api/alert', {durationSeconds: 5});
  assert.equal(alert.status, 202);
  assert.equal((await alert.json()).activeAction.type, 'alert');
  assert.equal((await post('/api/alert', {})).status, 409);
  assert.equal((await post('/api/reset', {})).status, 200);
  device.connect = async () => { throw new Error('unplugged'); }; device.connected = false;
  assert.equal((await post('/api/head', {color: 'red'})).status, 503);
});
