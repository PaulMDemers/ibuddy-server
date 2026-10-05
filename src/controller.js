import {setTimeout as sleep} from 'node:timers/promises';
import {IDLE, commandByte} from './protocol.js';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Controller {
  constructor(device, {cooldownMs = 2000, wait = sleep} = {}) {
    this.device = device;
    this.state = {...IDLE};
    this.current = null;
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
      busy: Boolean(this.current) || this.resetting, ledExpiresAt: this.ledExpiresAt,
      motionCooldownMs: Math.max(0, this.motionReadyAt - Date.now())};
  }
  async write(patch) {
    const next = {...this.state, ...patch};
    await this.device.send(next);
    this.state = next;
  }
  exclusive(fn, motion = false) {
    if (this.stopping) throw new ApiError(503, 'Server is shutting down');
    if (this.current || this.resetting) throw new ApiError(409, 'Device busy; retry after the current action');
    if (motion && Date.now() < this.motionReadyAt) throw new ApiError(429, 'Motor cooldown; retry in two seconds');
    const abort = new AbortController();
    const action = {abort, promise: null};
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
