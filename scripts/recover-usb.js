import {readFile, mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify, parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {scanUsb, recover, writeMapping, atomicWrite} from './lib/usb-recovery.js';
const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const statePath = `${root}runtime/usb-recovery.json`;
const mappingPath = `${root}compose.usb.yaml`;
const format = '{"id":{{json .Id}},"running":{{json .State.Running}},"devices":{{json .HostConfig.Devices}}}';
async function docker(args, timeout = 10000) {
  try { return (await run('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], {cwd: root, timeout, maxBuffer: 256 * 1024})).stdout; }
  // Docker/Compose stderr can contain expanded configuration; never emit it.
  catch { throw Error('Docker command failed; check Docker and the i-Buddy service logs'); }
}
async function inspect() {
  return JSON.parse(await docker(['inspect', '--format', format, 'ibuddy-api']));
}
try {
  // Fail closed on unavailable Docker, rather than treating it as zero hardware.
  await docker(['info', '--format', '{{.ServerVersion}}']);
  let container;
  const names = (await docker(['container', 'ls', '-a', '--format', '{{.Names}}'])).trim().split('\n');
  if (names.includes('ibuddy-api')) container = await inspect();
  let state = {};
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = parseEnv(await readFile(`${root}.env`, 'utf8'));
  const bind = config.BIND_IP && !['0.0.0.0', '::'].includes(config.BIND_IP) ? config.BIND_IP : '127.0.0.1';
  const host = bind.includes(':') ? `[${bind}]` : bind;
  await mkdir(`${root}runtime`, {recursive: true, mode: 0o700});
  await recover({devices: await scanUsb(), container, state,
    save: next => atomicWrite(statePath, JSON.stringify(next) + '\n'),
    getStatus: async () => {
      let response;
      try {
        response = await fetch(`http://${host}:8082/api/status`, {
          headers: {authorization: `Bearer ${config.API_TOKEN || ''}`}, signal: AbortSignal.timeout(2000)});
      } catch { return null; }
      if (!response.ok) throw Error(`API status returned HTTP ${response.status}; recovery deferred`);
      const status = await response.json();
      if (typeof status.busy !== 'boolean') throw Error('Invalid API status; recovery deferred');
      return status;
    },
    reserve: async () => {
      let response;
      try {
        response = await fetch(`http://${host}:8082/api/maintenance`, {
          method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${config.API_TOKEN || ''}`},
          body: '{}', signal: AbortSignal.timeout(2000)});
      } catch { throw Error('API maintenance unreachable; recovery deferred'); }
      if (response.status === 409) return false;
      if (!response.ok) throw Error(`API maintenance returned HTTP ${response.status}; recovery deferred`);
      return true;
    },
    apply: async devices => {
      await writeMapping(mappingPath, devices);
      await docker(['compose', '-f', 'compose.yaml', '-f', 'compose.usb.yaml', 'up', '-d',
        '--no-build', '--pull', 'never', '--force-recreate', '--wait', '--wait-timeout', '20', 'api'], 45000);
      return inspect();
    }
  });
} catch (error) {
  console.error(`USB recovery: ${error.message}`);
  process.exitCode = 1;
}
