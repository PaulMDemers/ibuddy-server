import {readFile, writeFile, chmod} from 'node:fs/promises';
import {scanUsb, writeMapping} from './lib/usb-recovery.js';
const devices = await scanUsb();
if (!devices.length) throw new Error('No supported i-Buddies attached (1130:0001 or 1130:0002)');
await writeMapping('compose.usb.yaml', devices);
let env = '';
try { env = await readFile('.env', 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = 'COMPOSE_FILE=compose.yaml:compose.usb.yaml';
env = /^COMPOSE_FILE=.*$/m.test(env) ? env.replace(/^COMPOSE_FILE=.*$/m, config) : env.trimEnd() + '\n' + config + '\n';
await writeFile('.env', env, {mode: 0o600});
await chmod('.env', 0o600);
console.log(`Mapped ${devices.length} i-Buddies. Run docker compose up -d --build --force-recreate.`);
for (const d of devices) console.log(`${d.id}: device node ${d.path}`);
