import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMacro, finalizeMacro, mergeDelays, heldKeys, allocateSlot, macroIdForSlot, uniqueName, exportMacroJSON, parseMacroJSON,
} from '../web/js/macro-library.js';
import { encodeMacro, decodeMacro } from '../web/js/codec.js';

const down = (v) => ({ type: 'keyboard', action: 'down', value: v });
const up = (v) => ({ type: 'keyboard', action: 'up', value: v });
const wait = (v) => ({ type: 'delay', value: v });

test('validation follows the vendor save rules', () => {
  assert.match(validateMacro([]), /empty/);
  assert.match(validateMacro([wait(10), down(4), up(4)]), /start with a key/);
  assert.match(validateMacro([down(4), wait(10)]), /must also come up/);
  assert.equal(validateMacro([down(4), wait(10), up(4)]), null);
  assert.deepEqual(heldKeys([down(4), down(5), up(4)]).map((e) => e.value), [5]);
});

test('finalize merges delays and always ends with a delay', () => {
  assert.deepEqual(mergeDelays([down(4), wait(40000), wait(40000), up(4)]), [down(4), wait(65535), up(4)]);
  const f = finalizeMacro([down(4), wait(20), up(4)]);
  assert.deepEqual(f.at(-1), wait(50));
  assert.deepEqual(finalizeMacro([down(4), wait(20), up(4)], 7).at(-1), wait(7));
  // the stored macro round-trips through the keyboard byte format
  assert.deepEqual(decodeMacro(encodeMacro(f, 3)), { events: f, repeatCount: 3 });
});

test('slots: reuse, lowest free, skip slots used by keys, error when full', () => {
  const map = {};
  assert.equal(allocateSlot(map, 'a', new Set([0, 2]), 20), 1);
  assert.equal(allocateSlot(map, 'a', new Set(), 20), 1);
  assert.equal(allocateSlot(map, 'b', new Set([0, 2]), 20), 3);
  assert.equal(macroIdForSlot(map, 3), 'b');
  assert.throws(() => allocateSlot({}, 'c', new Set([0, 1]), 2), /slots are in use/);
});

test('names and import/export', () => {
  assert.equal(uniqueName(['Macro_1', 'Macro_2'], 'Macro'), 'Macro_3');
  const m = { name: 'Copy', mode: 'on_off', repeat: 1, events: [down(224), down(6), wait(10), up(6), up(224)] };
  assert.deepEqual(parseMacroJSON(exportMacroJSON(m)), [m]);
  assert.throws(() => parseMacroJSON('{"x":1}'), /Not an Akko Cloud macro/);
});
