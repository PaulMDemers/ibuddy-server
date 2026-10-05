import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IDLE, commandByte, report} from '../src/protocol.js';

test('Known output reports preserve active-low LED and actuator bitfields', () => {
  assert.equal(commandByte(IDLE), 0xff);
  for (const [patch, expected] of [[{head: 'red'}, 0xef], [{head: 'blue'}, 0xbf],
    [{head: 'purple'}, 0xaf], [{head: 'white'}, 0x8f], [{heart: true}, 0x7f],
    [{wings: 'up'}, 0xf7], [{wings: 'down'}, 0xfb], [{turn: 'left'}, 0xfd], [{turn: 'right'}, 0xfe]]) {
    assert.equal(commandByte({...IDLE, ...patch}), expected);
  }
  assert.deepEqual([...report({head: 'blue', heart: true, wings: 'up', turn: 'left'})],
    [0x55, 0x53, 0x42, 0x43, 0, 0x40, 2, 0x35]);
  assert.throws(() => report({...IDLE, turn: 'forever'}));
  assert.throws(() => report({...IDLE, heart: 'false'}));
});
