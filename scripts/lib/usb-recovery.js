import {readdir, readFile, stat, writeFile, rename, chmod} from 'node:fs/promises';
import {join} from 'node:path';

export async function scanUsb({sysfs = '/sys/bus/usb/devices', devfs = '/dev/bus/usb', nodeStat = stat} = {}) {
  const devices = [];
  for (const port of await readdir(sysfs)) {
    if (!/^\d+-\d+(?:\.\d+)*$/.test(port)) continue;
    const directory = join(sysfs, port);
    try {
      const vendor = (await readFile(join(directory, 'idVendor'), 'utf8')).trim();
      if (vendor !== '1130') continue;
      const product = (await readFile(join(directory, 'idProduct'), 'utf8')).trim();
      if (!['0001', '0002'].includes(product)) continue;
      const bus = Number((await readFile(join(directory, 'busnum'), 'utf8')).trim());
      const address = Number((await readFile(join(directory, 'devnum'), 'utf8')).trim());
      if (!Number.isInteger(bus) || bus < 1 || !Number.isInteger(address) || address < 1 || address > 127) throw Error(`Invalid USB location at ${port}: bus=${bus}, address=${address}`);
      const path = join(devfs, String(bus).padStart(3, '0'), String(address).padStart(3, '0'));
      const node = await nodeStat(path, {bigint: true});
      if (!node.isCharacterDevice()) throw Error('USB node is not a character device');
      devices.push({id: `usb-${String(bus).padStart(3, '0')}-${port.split('-')[1]}-p${product}`, path,
        generation: `${node.ino}:${node.rdev}:${node.ctimeNs}`});
    } catch (error) {
      // A device can disappear between listing sysfs and reading its node.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return devices.sort((a, b) => a.id.localeCompare(b.id));
}

export function fingerprint(devices) {
  return JSON.stringify(devices.map(({id, path, generation}) => ({id, path, generation})));
}
export function mappingMatches(devices, mapped) {
  const paths = devices.map(d => d.path).sort();
  const actual = (mapped || []).map(d => d.PathOnHost).sort();
  return JSON.stringify(paths) === JSON.stringify(actual)
    && (mapped || []).every(d => d.PathInContainer === d.PathOnHost);
}
export async function atomicWrite(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, {mode: 0o600});
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}
export async function writeMapping(path, devices) {
  await atomicWrite(path, JSON.stringify({services: {api: {devices: devices.map(d => d.path)}}}, null, 2) + '\n');
}

// All decisions and durable state are shared by the one-shot service and tests.
export async function recover({devices, container, state, now = Date.now(), getStatus, reserve = async () => true, apply, save, log = console.log}) {
  const key = fingerprint(devices);
  const matches = mappingMatches(devices, container?.devices);
  if (!container) {
    log('API container absent; leaving it stopped.');
    return;
  }
  const applied = state.applied;
  const knownGenerationChange = applied && applied.containerId === container.id && applied.fingerprint !== key;
  if (matches && !knownGenerationChange) {
    await save({applied: {fingerprint: key, containerId: container.id}});
    return;
  }
  if (state.pending?.fingerprint !== key) {
    await save({...state, pending: {fingerprint: key, since: now}, lastAttempt: null});
    log(`USB change detected (${devices.length} figures); waiting for a stable scan.`);
    return;
  }
  // Timer samples every 15 seconds; debounce transient unplug/replug sequences.
  if (now - state.pending.since < 10000 || (state.lastAttempt && now - state.lastAttempt < 30000)) return;
  let status = null;
  if (container.running) {
    status = await getStatus();
    if (status?.busy) { log('USB recovery waiting for the active routine to finish.'); return; }
    // A silent/unreachable running API might still own a bounded 60s animation.
    if (!status && now - state.pending.since < 75000) {
      log('USB recovery waiting for API status or the routine grace period.');
      return;
    }
  }
  if (container.running && status && !await reserve()) {
    log('A new routine started; USB recovery deferred.');
    return;
  }
  await save({...state, lastAttempt: now});
  log(`Refreshing Docker USB mappings for ${devices.length} figures.`);
  const refreshed = await apply(devices);
  await save({applied: {fingerprint: key, containerId: refreshed.id}});
  log(`USB recovery completed (${devices.length} mapped figures).`);
}
