import {setTimeout as sleep} from 'node:timers/promises';

const base = process.env.API_URL || 'http://127.0.0.1:8082';
const token = process.env.API_TOKEN || '';
const headers = {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})};
async function post(path, input) {
  const response = await fetch(`${base}/api/${path}`, {method: 'POST', headers, body: JSON.stringify(input)});
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${result.error}`);
  console.log(`${path}: accepted USB output 0x${result.commandByte.toString(16)}; ${JSON.stringify(result.state)}`);
}
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch(`${base}/health`);
    ready = response.ok && (await response.json()).deviceConnected;
  } catch {}
  if (ready) break;
  await sleep(200);
}
if (!ready) throw new Error('API/device not ready; check /health and the server logs');
try {
  for (const color of ['red', 'green', 'blue', 'purple', 'off']) {
    await post('head', {color, ttlSeconds: 10}); await sleep(600);
  }
  await post('heart', {on: true, ttlSeconds: 10}); await sleep(700);
  await post('heart', {on: false});
  await post('flap', {count: 2, intervalMs: 150}); await sleep(2200);
  await post('turn', {direction: 'left', durationMs: 150}); await sleep(2200);
  await post('turn', {direction: 'right', durationMs: 150});
} finally { await post('reset', {}); }
