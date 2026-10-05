import {usb} from 'usb';
import {writeFile, readFile, chmod} from 'node:fs/promises';
import {describe} from '../src/fleet.js';
const devices = (await usb.getDevices()).map(raw => describe(raw)).filter(Boolean);
if (!devices.length) throw new Error('No supported i-Buddies attached (1130:0001 or 1130:0002)');
const paths = devices.map(d => `/dev/bus/usb/${String(Number(d.bus)).padStart(3, '0')}/${String(d.address).padStart(3, '0')}`);
await writeFile('compose.usb.yaml', JSON.stringify({services: {api: {devices: paths}}}, null, 2) + '\n', {mode: 0o600});
let env = '';
try { env = await readFile('.env', 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = 'COMPOSE_FILE=compose.yaml:compose.usb.yaml';
env = /^COMPOSE_FILE=.*$/m.test(env) ? env.replace(/^COMPOSE_FILE=.*$/m, config) : env.trimEnd() + '\n' + config + '\n';
await writeFile('.env', env, {mode: 0o600});
await chmod('.env', 0o600);
console.log(`Mapped ${devices.length} i-Buddies. Run docker compose up -d --build --force-recreate.`);
for (const d of devices) console.log(`${d.id}: product ${d.productId}`);
