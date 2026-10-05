export const HEAD_BITS = Object.freeze({off: 0, red: 0x10, green: 0x20, blue: 0x40,
  yellow: 0x30, cyan: 0x60, purple: 0x50, magenta: 0x50, white: 0x70});
export const IDLE = Object.freeze({head: 'off', heart: false, wings: 'idle', turn: 'idle'});
export const SETUP = Buffer.from([0x22, 0x09, 0x00, 0x02, 0x01, 0, 0, 0]);
export const TRANSFER = Object.freeze({requestType: 'class', recipient: 'interface', request: 9, value: 2, index: 1});

export function commandByte(state) {
  if (!Object.hasOwn(HEAD_BITS, state.head) || typeof state.head !== 'string'
    || typeof state.heart !== 'boolean' || !['idle', 'up', 'down'].includes(state.wings)
    || !['idle', 'left', 'right'].includes(state.turn)) throw new TypeError('Invalid i-Buddy state');
  return (0xff & ~HEAD_BITS[state.head] & ~(state.heart ? 0x80 : 0)
    & ~0x0f) | ({idle: 3, up: 1, down: 2}[state.wings] << 2)
    | {idle: 3, left: 1, right: 2}[state.turn];
}

export function report(state) {
  return Buffer.from([0x55, 0x53, 0x42, 0x43, 0, 0x40, 2, commandByte(state)]);
}
