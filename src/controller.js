import {setTimeout as sleep} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {IDLE, commandByte} from './protocol.js';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Controller {
  constructor(device, {cooldownMs = 2000, wait = sleep} = {}) {
    this.device = device;
    this.state = {...IDLE};
    this.current = null;
    this.lastAlert = null;
    this.resetting = false;
    this.stopping = false;
    this.ledTimer = null;
    this.ledExpiresAt = null;
    this.cooldownMs = cooldownMs;
    this.motionReadyAt = 0;
    this.wait = wait;
  }
  status() {
    return {...this.device.info(), state: {...this.state}, commandByte: commandByte(this.state),
      stateSource: 'last acknowledged USB output; no physical position feedback',
      busy: Boolean(this.current) || this.resetting, activeAction: this.current?.metadata || null, lastAlert: this.lastAlert, ledExpiresAt: this.ledExpiresAt,
      motionCooldownMs: Math.max(0, this.motionReadyAt - Date.now())};
  }
  async write(patch) {
    const next = {...this.state, ...patch};
    await this.device.send(next);
    this.state = next;
  }
  exclusive(fn, motion = false, metadata = null) {
    if (this.stopping) throw new ApiError(503, 'Server is shutting down');
    if (this.current || this.resetting) throw new ApiError(409, 'Device busy; retry after the current action');
    if (motion && Date.now() < this.motionReadyAt) throw new ApiError(429, 'Motor cooldown; retry in two seconds');
    const abort = new AbortController();
    const action = {abort, promise: null, metadata};
    this.current = action;
    action.promise = (async () => {
      try {
        const wasConnected = this.device.connected;
        await this.device.connect();
        if (!wasConnected) this.state = {...IDLE};
        if (abort.signal.aborted) throw new ApiError(409, 'Action cancelled by reset');
        await fn(abort.signal);
      } catch (error) {
        if (error.name === 'AbortError') throw new ApiError(409, 'Action cancelled by reset');
        throw error;
      } finally {
        if (motion) this.motionReadyAt = Date.now() + this.cooldownMs;
        this.current = null;
      }
      return this.status();
    })();
    return action.promise;
  }
  armLeds(ttlMs) {
    clearTimeout(this.ledTimer);
    this.ledExpiresAt = Date.now() + ttlMs;
    const expire = () => {
      // An in-flight short motion will release the controller within seconds.
      if (this.current || this.resetting) { this.ledTimer = setTimeout(expire, 100); return; }
      this.exclusive(() => this.write({head: 'off', heart: false}))
        .catch(error => console.error('LED auto-off failed:', error.message));
      this.ledExpiresAt = null;
    };
    this.ledTimer = setTimeout(expire, ttlMs);
    this.ledTimer.unref();
  }
  leds(patch, ttlMs) {
    return this.exclusive(async () => { await this.write(patch); this.armLeds(ttlMs); });
  }
  flap(count, intervalMs) {
    return this.exclusive(async signal => {
      try {
        for (let i = 0; i < count; i++) {
          await this.write({wings: 'up'});
          await this.wait(intervalMs, undefined, {signal});
          await this.write({wings: 'down'});
          await this.wait(intervalMs, undefined, {signal});
          await this.write({wings: 'idle'});
          await this.wait(100, undefined, {signal});
        }
      } finally { await this.write({wings: 'idle', turn: 'idle'}); }
    }, true);
  }
  turn(direction, durationMs) {
    return this.exclusive(async signal => {
      try {
        await this.write({turn: direction});
        await this.wait(durationMs, undefined, {signal});
      } finally { await this.write({wings: 'idle', turn: 'idle'}); }
    }, true);
  }
  async alert(durationSeconds = 30) {
    const metadata = {id: randomUUID(), type: 'alert', startedAt: new Date().toISOString(), durationSeconds};
    let ready, failed;
    const started = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    const frames = [
      [{head: 'red', heart: true, wings: 'up'}, 150],
      [{wings: 'down'}, 150],
      [{wings: 'idle', turn: 'left'}, 150],
      [{turn: 'idle'}, 550],
      [{head: 'blue', heart: false}, 500],
      [{head: 'red', heart: true}, 500],
      [{head: 'blue', heart: false}, 500],
      [{head: 'off'}, 500],
    ];
    // A three-second cycle leaves motors idle for over two seconds between bursts.
    const task = this.exclusive(async signal => {
      clearTimeout(this.ledTimer);
      this.ledExpiresAt = null;
      try {
        await this.write({...IDLE, head: 'red', heart: true});
        ready();
        let elapsed = 0, cycle = 0;
        while (elapsed < durationSeconds * 1000) {
          for (const [patch, delay] of frames) {
            if (elapsed >= durationSeconds * 1000) break;
            await this.write(patch.turn === 'left' ? {...patch, turn: cycle % 2 ? 'right' : 'left'} : patch);
            const interval = Math.min(delay, durationSeconds * 1000 - elapsed);
            await this.wait(interval, undefined, {signal});
            elapsed += interval;
          }
          cycle++;
        }
      } finally { await this.write(IDLE); }
    }, true, metadata);
    task.then(() => { this.lastAlert = {...metadata, outcome: 'completed'}; }, error => {
      failed(error);
      this.lastAlert = {...metadata, outcome: error.status === 409 ? 'cancelled' : 'failed'};
      if (error.status !== 409) console.error('Alert failed:', error.message);
    });
    await started;
    return this.status();
  }
  async reset() {
    if (this.resetting) throw new ApiError(409, 'Reset already in progress');
    this.resetting = true;
    clearTimeout(this.ledTimer);
    this.ledExpiresAt = null;
    try {
      const active = this.current;
      if (active) { active.abort.abort(); try { await active.promise; } catch {} }
      clearTimeout(this.ledTimer);
      this.ledExpiresAt = null;
      await this.device.connect();
      await this.write(IDLE);
    } finally { this.resetting = false; }
    return this.status();
  }
  async close() {
    this.stopping = true;
    try { if (this.device.connected || this.current) await this.reset(); }
    finally { clearTimeout(this.ledTimer); await this.device.close(); }
  }
}
