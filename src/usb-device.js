import {usb} from 'usb';
import {IDLE, SETUP, TRANSFER, report} from './protocol.js';

export class UsbDevice {
  constructor({raw = null, descriptor = null} = {}) {
    this.raw = raw;
    this.descriptor = descriptor;
    this.device = null;
    this.isConnected = false;
    this.location = null;
    this.detached = false;
    this.lastError = null;
  }
  get connected() { return this.isConnected; }
  async connect() {
    if (this.connected) return;
    let device = this.raw;
    if (!device) {
      const candidates = (await usb.getDevices()).filter(d => d.vendorId === 0x1130 && [1, 2].includes(d.productId));
      if (candidates.length !== 1) throw new Error(candidates.length ? 'Choose a device from /api/devices' : 'i-Buddy not connected');
      device = candidates[0];
    }
    try {
      await device.open();
      this.device = device;
      if (!device.configuration) await device.selectConfiguration(1);
      try { await device.claimInterface(1); }
      catch (error) {
        if (process.platform !== 'linux') throw error;
        await device.detachKernelDriver(1);
        this.detached = true;
        await device.claimInterface(1);
      }
      // Cache metadata while idle: native USB getters cannot borrow a device
      // during an asynchronous transfer (usb 3.x). Status uses JS values only.
      this.location = this.descriptor ? {bus: this.descriptor.bus, address: this.descriptor.address} : {bus: device.bus, address: device.address};
      this.isConnected = true;
      await this.send(IDLE);
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      await this.close();
      throw error;
    }
  }
  async transfer(data) {
    const result = await this.device.controlTransferOut(TRANSFER, data, 500);
    if (result.status !== 'ok' || result.bytesWritten !== 8) throw new Error('Incomplete USB output report');
  }
  async send(state) {
    if (!this.connected) throw new Error('i-Buddy not connected');
    try {
      await this.transfer(SETUP);
      await this.transfer(report(state));
    } catch (error) {
      this.lastError = error.message;
      await this.close();
      throw error;
    }
  }
  async close() {
    const device = this.device;
    this.device = null;
    this.isConnected = false;
    this.location = null;
    if (!device) return;
    try { await device.releaseInterface(1); } catch {}
    if (this.detached) { try { await device.attachKernelDriver(1); } catch {} }
    this.detached = false;
    try { await device.close(); } catch {}
  }
  info() {
    return {connected: this.connected, vendorId: '1130', productId: this.descriptor?.productId || '0002', interface: 1,
      ...(this.connected ? this.location : {})};
  }
}
