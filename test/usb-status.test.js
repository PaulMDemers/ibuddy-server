import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UsbDevice} from '../src/usb-device.js';

test('Status reads cached JS values while native device is borrowed by a USB transfer', () => {
  const d = new UsbDevice();
  d.device = new Proxy({}, {get() { throw new Error('native value already borrowed'); }});
  d.isConnected = true;
  d.location = {bus: '001', address: 10};
  assert.equal(d.connected, true);
  assert.deepEqual(d.info(), {connected: true, vendorId: '1130', productId: '0002', interface: 1, bus: '001', address: 10});
  d.isConnected = false;
  assert.equal(d.info().connected, false);
  assert.equal(d.info().address, undefined);
});
