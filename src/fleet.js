import {usb} from 'usb';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Controller, ApiError} from './controller.js';
import {UsbDevice} from './usb-device.js';

export function describe(raw, readAddress = path => readFileSync(path, 'utf8')) {
  if (raw.vendorId !== 0x1130 || ![1, 2].includes(raw.productId)) return null;
  const bus = String(raw.bus), ports = [...raw.ports], productId = raw.productId.toString(16).padStart(4, '0');
  let address = raw.address;
  // usb 3.x can report address zero until open; Linux sysfs is readable
  // without opening the root-owned USB node, including in scoped containers.
  if (!address && process.platform === 'linux' && ports.length) {
    address = Number(readAddress(`/sys/bus/usb/devices/${Number(bus)}-${ports.join('.')}/devnum`).trim());
  }
  if (!Number.isInteger(address) || address < 1 || address > 127) throw new Error('USB address unavailable');
  // Port topology survives USB address changes; moving ports changes the id.
  const id = `usb-${bus}-${ports.length ? ports.join('.') : `address${address}`}-p${productId}`;
  return {id, bus, ports, address, productId};
}

export class Fleet {
  constructor({discover = () => usb.getDevices(), makeController = (raw, descriptor) => new Controller(new UsbDevice({raw, descriptor}))} = {}) {
    this.discover = discover;
    this.makeController = makeController;
    this.entries = new Map();
    this.refreshing = null;
    this.group = null;
    this.lastAlert = null;
    this.lastDance = null;
    this.stopping = false;
    this.maintenanceUntil = 0;
  }
  get device() { return {connected: this.status().connected}; }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    if (this.stopping || this.status().busy) return;
    this.refreshing = (async () => {
      const rawDevices = await this.discover();
      // Don't touch native getters while a LED expiry/action holds a USB borrow.
      if (this.status().busy) return;
      const found = rawDevices.map(raw => ({raw, descriptor: describe(raw)})).filter(x => x.descriptor);
      const ids = new Set(found.map(x => x.descriptor.id));
      for (const [id, entry] of this.entries) {
        if (!ids.has(id) && entry.present) {
          entry.present = false;
          try { await entry.controller.close(); } catch {}
        }
      }
      const connect = [];
      for (const {raw, descriptor} of found) {
        let entry = this.entries.get(descriptor.id);
        if (!entry?.present || entry.descriptor.address !== descriptor.address || !entry.controller.device.connected) {
          if (entry?.present) { try { await entry.controller.close(); } catch {} }
          entry = {descriptor, present: true, controller: this.makeController(raw, descriptor)};
          this.entries.set(descriptor.id, entry);
          connect.push(entry.controller.device.connect().catch(error => console.error(`USB ${descriptor.id}:`, error.message)));
        }
      }
      await Promise.all(connect);
    })();
    try { await this.refreshing; } finally { this.refreshing = null; }
  }
  status() {
    const devices = [...this.entries.values()].map(e => ({id: e.descriptor.id, present: e.present, ...e.controller.status()}));
    const present = devices.filter(d => d.present);
    return {connected: present.some(d => d.connected), deviceCount: present.length,
      connectedCount: present.filter(d => d.connected).length, devices,
      state: present.length === 1 ? present[0].state : null,
      stateSource: 'last acknowledged USB outputs per device; no physical feedback',
      busy: this.maintenanceUntil > Date.now() || Boolean(this.group) || present.some(d => d.busy),
      maintenanceUntil: this.maintenanceUntil > Date.now() ? new Date(this.maintenanceUntil).toISOString() : null,
      activeAction: this.group?.metadata || null, lastAlert: this.lastAlert, lastDance: this.lastDance,
      motionCooldownMs: Math.max(0, ...present.map(d => d.motionCooldownMs))};
  }
  quiesce() {
    if (this.stopping) throw new ApiError(503, 'Server is shutting down');
    if (this.refreshing || this.status().busy) throw new ApiError(409, 'An i-Buddy is busy; recovery deferred');
    // Reserve an idle fleet before the host recreates Docker USB mappings.
    // A failed restart releases the reservation automatically after 30 seconds.
    this.maintenanceUntil = Date.now() + 30000;
    return this.status();
  }
  async list() { await this.refresh(); return this.status(); }
  async getController(id) {
    await this.refresh();
    const entry = this.entries.get(id);
    if (!entry?.present) throw new ApiError(404, 'Unknown or disconnected device');
    return entry.controller;
  }
  async selected(motion = false) {
    if (this.stopping) throw new ApiError(503, 'Server is shutting down');
    await this.refresh();
    const entries = [...this.entries.values()].filter(e => e.present);
    if (!entries.length) throw new ApiError(503, 'No i-Buddies available');
    if (this.maintenanceUntil > Date.now()) throw new ApiError(503, 'USB recovery in progress');
    if (this.group || entries.some(e => e.controller.status().busy)) throw new ApiError(409, 'An i-Buddy is busy');
    if (motion && entries.some(e => e.controller.status().motionCooldownMs > 0)) throw new ApiError(429, 'Motor cooldown; retry in two seconds');
    return entries;
  }
  assertReady(entries, motion) {
    if (this.stopping) throw new ApiError(503, 'Server is shutting down');
    if (this.maintenanceUntil > Date.now()) throw new ApiError(503, 'USB recovery in progress');
    if (this.group || entries.some(e => e.controller.status().busy)) throw new ApiError(409, 'An i-Buddy is busy');
    if (motion && entries.some(e => e.controller.status().motionCooldownMs > 0)) throw new ApiError(429, 'Motor cooldown; retry in two seconds');
  }
  async broadcast(method, args, motion = false) {
    const entries = await this.selected(motion);
    this.assertReady(entries, motion);
    const results = await Promise.allSettled(entries.map(e => e.controller[method](...args)));
    if (results.some(r => r.status === 'rejected')) {
      const error = new ApiError(503, 'One or more i-Buddies rejected the command');
      error.results = results.map((r,i) => ({id: entries[i].descriptor.id, ok: r.status === 'fulfilled'}));
      throw error;
    }
    return this.status();
  }
  leds(patch, ttl) { return this.broadcast('leds', [patch, ttl]); }
  flap(count, interval) { return this.broadcast('flap', [count, interval], true); }
  turn(direction, duration) { return this.broadcast('turn', [direction, duration], true); }
  async routine(type, duration) {
    const entries = await this.selected(true);
    this.assertReady(entries, true);
    const metadata = {id: randomUUID(), type, durationSeconds: duration, startedAt: new Date().toISOString(), deviceIds: entries.map(e => e.descriptor.id)};
    let release;
    const startGate = new Promise(resolve => { release = resolve; });
    const group = {metadata};
    this.group = group;
    const starts = await Promise.allSettled(entries.map(e => type === 'dance'
      ? e.controller.dance({metadata, startGate}) : e.controller.alert(duration, {metadata, startGate})));
    if (starts.some(r => r.status === 'rejected')) {
      // Abort before opening the barrier, so ready devices never begin moving.
      const stops = entries.map(e => e.controller.reset());
      release();
      await Promise.allSettled(stops);
      this.group = null;
      const error = new ApiError(503, 'Could not start all i-Buddies; all started devices were stopped');
      error.results = starts.map((r,i) => ({id: entries[i].descriptor.id, ok: r.status === 'fulfilled'}));
      throw error;
    }
    const finishes = entries.map(e => e.controller.current.promise);
    release();
    group.done = Promise.allSettled(finishes).then(results => {
      const outcome = results.some(r => r.status === 'rejected' && r.reason.status !== 409) ? 'failed'
        : results.some(r => r.status === 'rejected') ? 'cancelled' : 'completed';
      this[type === 'dance' ? 'lastDance' : 'lastAlert'] = {...metadata, outcome,
        results: results.map((r,i) => ({id: entries[i].descriptor.id, outcome: r.status === 'fulfilled' ? 'completed' : r.reason.status === 409 ? 'cancelled' : 'failed'}))};
      if (this.group === group) this.group = null;
    });
    return this.status();
  }
  dance() { return this.routine('dance', 25); }
  alert(duration) { return this.routine('alert', duration); }
  async reset() {
    const results = await Promise.allSettled([...this.entries.values()].filter(e => e.present).map(e => e.controller.reset()));
    if (this.group?.done) await this.group.done;
    if (results.some(r => r.status === 'rejected')) throw new ApiError(503, 'One or more devices could not reset; other devices were reset');
    return this.status();
  }
  async close() {
    this.stopping = true;
    await Promise.allSettled([...this.entries.values()].map(e => e.controller.close()));
    if (this.group?.done) await this.group.done;
  }
}
