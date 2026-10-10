// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keyboard, CMD, Checksum, applyChecksum, packet } from '../web/js/protocol.js';
import { encodeMacro, decodeMacro, encodeAction, decodeAction, macroByteLength } from '../web/js/codec.js';
import { DemoTransport } from '../web/js/transports.js';
import { MODELS, findModel, LAYOUT, KNOB } from '../web/js/models.js';

const fastKb = (t) => {
  const kb = new Keyboard(t);
  // strip protocol pacing so the suite runs quickly
  kb.write = async function (bytes, cs = Checksum.BIT7) {
    await this.t.sendFeature(applyChecksum(packet(bytes), cs));
  };
  kb.read = async function () {
    return this.t.receiveFeature();
  };
  return kb;
};
const setup = () => {
  const t = new DemoTransport(MODELS[0]);
  return { t, kb: fastKb(t) };
};
// Neutralise the protocol's post-write settle delays in tests.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms ?? 0, 1), ...a);

test('BIT7 checksum = 0xFF - sum(bytes 0..6) at byte 7 (matches native helper)', () => {
  const p = applyChecksum(packet([0x04, 0x00, 0x01]), Checksum.BIT7);
  assert.equal(p[7], 0xff - 0x05);
  const q = applyChecksum(packet([0x0d]), Checksum.BIT7);
  assert.equal(q[7], 0xf2); // the original driver hard-codes 255-13 for audio frames
});

test('BIT8 checksum covers bytes 0..7 and lands at byte 8', () => {
  const p = applyChecksum(packet([7, 2, 1, 4, 7, 0, 255, 0]), Checksum.BIT8);
  assert.equal(p[8], 255 - ((7 + 2 + 1 + 4 + 7 + 255) & 255));
  assert.equal(p[7], 0);
});

test('device id probe sends 0x8F and decodes u32le from bytes 1..4', async () => {
  const { t, kb } = setup();
  assert.equal(await kb.getDeviceId(), 413);
  assert.equal(t.sent[0][0], CMD.GET_INFOR);
  assert.equal(findModel(413).name, 'yc200_pc75b');
  assert.equal(findModel((0x80000000 | 594) >>> 0).name, 'yc300_pc75_s_plus'); // 2.4 GHz id
  assert.equal(findModel(1374).logo, false);
  assert.ok(findModel(999999).unknownId);
});

test('light packet layout (Breathing, green, speed 3, brightness 4)', async () => {
  const { t, kb } = setup();
  await kb.setLight({ type: 'LightBreath', value: 4, speed: 3, rgb: 0x00ff00, dazzle: false });
  const p = t.sent.at(-1);
  assert.deepEqual(Array.from(p.slice(0, 9)), [7, 2, 1, 4, 7, 0, 255, 0, 255 - ((7 + 2 + 1 + 4 + 7 + 255) & 255)]);
  assert.deepEqual(await kb.getLight(), { type: 'LightBreath', value: 4, speed: 3, rgb: 0x00ff00, dazzle: false });
});

test('light option nibbles and white substitution', () => {
  const wave = Keyboard.encodeLight(7, { type: 'LightWave', value: 2, speed: 1, rgb: 0xffffff, dazzle: true, option: 'up' }, true);
  assert.deepEqual(wave, [7, 4, 3, 2, (3 << 4) | 8, 0xfa, 0xff, 0xfa, 0]);
  assert.deepEqual(Keyboard.decodeLight(wave, true), { type: 'LightWave', value: 2, speed: 1, rgb: 0xffffff, dazzle: true, option: 'up' });
  const music = Keyboard.encodeLight(7, { type: 'LightMusicFollow3', value: 3, rgb: 0x112233, dazzle: false, option: 'separate' }, true);
  assert.deepEqual(music.slice(0, 5), [7, 20, 4, 3, (1 << 4) | 4]);
  const pic = Keyboard.encodeLight(7, { type: 'LightUserPicture', value: 4 }, true);
  assert.deepEqual(pic.slice(0, 8), [7, 13, 4, 4, 0, 0, 200, 200]);
});

test('every main effect round-trips through encode/decode', () => {
  for (const type of ['LightOff', 'LightAlwaysOn', 'LightBreath', 'LightNeon', 'LightWave', 'LightRipple', 'LightRaindrop', 'LightSnake',
    'LightPressAction', 'LightConverage', 'LightSineWave', 'LightKaleidoscope', 'LightLineWave', 'LightUserPicture', 'LightLaser',
    'LightCircleWave', 'LightDazzing', 'LightRainDown', 'LightMeteor', 'LightPressActionOff', 'LightMusicFollow3', 'LightScreenColor',
    'LightMusicFollow2', 'LightTrain', 'LightFireWorks']) {
    const d = Keyboard.decodeLight(Keyboard.encodeLight(7, { type, value: 3, speed: 2, rgb: 0x123456 }, true), true);
    assert.equal(d.type, type);
  }
});

test('logo light uses its own numbering (snake = 5) and no speed inversion', async () => {
  const { t, kb } = setup();
  await kb.setLogoLight({ type: 'LightSnake', value: 3, speed: 1, rgb: 0x0000ff, option: 'return' });
  assert.deepEqual(Array.from(t.sent.at(-1).slice(0, 8)), [8, 5, 1, 3, 16 | 7, 0, 0, 255]);
  assert.equal((await kb.getLogoLight()).type, 'LightSnake');
});

test('key matrix is written as 9 pages [0x09, profile, 0xF8, 1, page, 0, 0, csum] + 56 bytes', async () => {
  const { t, kb } = setup();
  const m = Uint8Array.from(MODELS[0].matrix);
  m.set([0, 0, 57, 0], 0); // Esc -> Caps Lock
  await kb.setKeyMatrix(m, 2);
  const pages = t.sent.filter((p) => p[0] === CMD.SET_KEYMATRIX);
  assert.equal(pages.length, 9);
  pages.forEach((p, i) => {
    assert.deepEqual(Array.from(p.slice(0, 5)), [9, 2, 0xf8, 1, i]);
    assert.equal(p[7], 255 - ((9 + 2 + 0xf8 + 1 + i) & 255));
  });
  assert.deepEqual(Array.from(pages[0].slice(8, 12)), [0, 0, 57, 0]);
  const back = await kb.getKeyMatrix(2);
  assert.deepEqual(Array.from(back.slice(0, 504)), Array.from(m.slice(0, 504)));
});

test('Fn layer uses 0x10 / 0x90', async () => {
  const { t, kb } = setup();
  const m = new Uint8Array(512);
  m.set([3, 0, 233, 0], 4 * 5);
  await kb.setFnMatrix(m, 1);
  assert.ok(t.sent.filter((p) => p[0] === 0x10).every((p) => p[1] === 1 && p[2] === 0xf8));
  assert.deepEqual(Array.from((await kb.getFnMatrix(1)).slice(20, 24)), [3, 0, 233, 0]);
});

test('macro encoding matches the original byte format', () => {
  const ev = [
    { type: 'keyboard', action: 'down', value: 4 },
    { type: 'delay', value: 30 }, // <=127 -> folded into flag byte
    { type: 'keyboard', action: 'up', value: 4 },
    { type: 'delay', value: 500 }, // >127 -> 16-bit field
    { type: 'keyboard', action: 'down', value: 5 },
    { type: 'keyboard', action: 'up', value: 5 },
  ];
  const b = encodeMacro(ev, 3);
  assert.deepEqual(Array.from(b.slice(0, 14)), [3, 0, 4, 0x80 | 30, 4, 0, 0xf4, 0x01, 5, 0x80, 0, 0, 5, 0]);
  assert.equal(macroByteLength(ev), 14);
  const d = decodeMacro(b);
  assert.equal(d.repeatCount, 3);
  assert.deepEqual(d.events, [
    { type: 'keyboard', action: 'down', value: 4 }, { type: 'delay', value: 30 },
    { type: 'keyboard', action: 'up', value: 4 }, { type: 'delay', value: 500 },
    { type: 'keyboard', action: 'down', value: 5 }, { type: 'keyboard', action: 'up', value: 5 },
  ]);
});

test('macro upload: 5 pages [0x0B, idx, 0, 1, page, ..] and read back via 0x8B', async () => {
  const { t, kb } = setup();
  const ev = [{ type: 'keyboard', action: 'down', value: 30 }, { type: 'delay', value: 10 }, { type: 'keyboard', action: 'up', value: 30 }];
  await kb.setMacro(7, ev, 1);
  const pages = t.sent.filter((p) => p[0] === CMD.SET_MACRO);
  assert.equal(pages.length, 5);
  assert.deepEqual(Array.from(pages[4].slice(0, 5)), [0x0b, 7, 0, 1, 4]);
  assert.deepEqual((await kb.getMacro(7)).events, [{ type: 'keyboard', action: 'down', value: 30 }, { type: 'delay', value: 10 }, { type: 'keyboard', action: 'up', value: 30 }]);
});

test('macro that overflows 256 bytes is rejected', () => {
  const ev = [];
  for (let i = 0; i < 80; i++) ev.push({ type: 'keyboard', action: 'down', value: 4 }, { type: 'delay', value: 1000 });
  assert.throws(() => encodeMacro(ev), RangeError);
});

test('key action codec', () => {
  assert.deepEqual(encodeAction({ type: 'combo', mod: 'ctrl', hid: 6 }), [0, 224, 6, 0]);
  assert.deepEqual(encodeAction({ type: 'macro', index: 3, mode: 'on_off' }), [9, 1, 3, 0]);
  assert.deepEqual(decodeAction([3, 0, 233, 0]).label, 'Volume up');
  assert.deepEqual(decodeAction([0, 0, 41, 0]), { type: 'key', hid: 41 });
  assert.equal(decodeAction([13, 2, 1, 0]).type, 'raw');
});

test('options, sleep, debounce, report rate, profile packets', async () => {
  const { t, kb } = setup();
  await kb.setProfile(1);
  assert.deepEqual(Array.from(t.sent.at(-1).slice(0, 2)), [5, 1]);
  await kb.setReportRate(500);
  assert.deepEqual(Array.from(t.sent.at(-1).slice(0, 3)), [4, 1, 2]);
  assert.equal(await kb.getReportRate(), 500);
  await kb.setKeyboardOption({ raw: 0b110, winKeyLock: true, wasdArrowSwap: false, ledOff: true, logoLedOff: false, keyboardMode: false, keyboardLock: false, fnMatrix: true, powerSave: true });
  assert.deepEqual(Array.from(t.sent.at(-1).slice(0, 5)), [6, 1, 0b10111, 1, 1]);
  await kb.setSleepTime({ bt: 600, rf: 300, deepBt: 1800, deepRf: 0 });
  assert.deepEqual(Array.from(t.sent.at(-1).slice(8, 16)), [88, 2, 44, 1, 8, 7, 0, 0]);
  assert.deepEqual(await kb.getSleepTime(), { bt: 600, rf: 300, deepBt: 1800, deepRf: 0 });
  await kb.setDebounce(4);
  assert.equal(await kb.getDebounce(), 4);
});

test('per-key picture: 7 x 56-byte pages, length field 384', async () => {
  const { t, kb } = setup();
  const pic = new Uint8Array(384);
  pic.set([255, 0, 0], 3 * 41); // space bar red
  await kb.setUserPicture(pic);
  const pages = t.sent.filter((p) => p[0] === CMD.SET_USERPIC);
  assert.equal(pages.length, 7);
  assert.deepEqual(Array.from(pages[0].slice(0, 5)), [12, 0, 0x80, 0x01, 0]);
  assert.deepEqual(Array.from((await kb.getUserPicture()).slice(123, 126)), [255, 0, 0]);
});

test('layout covers every PC75B key exactly once', () => {
  const idx = LAYOUT.map((k) => k.idx);
  assert.equal(new Set(idx).size, idx.length);
  assert.equal(idx.length, 82);
  const m = MODELS[0].matrix;
  for (const i of idx) assert.ok(m.slice(i * 4, i * 4 + 4).some((b) => b !== 0), `slot ${i} empty`);
  assert.deepEqual(Array.from(m.slice(KNOB.press * 4, KNOB.press * 4 + 4)), [10, 15, 0, 0]);
});

// Behaviour observed on a real 2.4 GHz receiver (25a7:2420) + vendor helper:
// [FB] status = [is_ready_read, battery, offline, is_write_finish]. Writes only
// set is_write_finish; queries also set is_ready_read; [FC] fetches the reply.
class FakeReceiver {
  constructor({ asleepPolls = 0, stall = false, busyPolls = 0 } = {}) {
    this.kb = new DemoTransport(MODELS[1]);
    this.stall = stall; // the keyboard never confirms a command
    this.busyPolls = busyPolls; // a previous write is still in flight
    this.log = [];
    this.pending = 0;
    this.reply = false;
    this.asleepPolls = asleepPolls;
    this.out = new Uint8Array(64);
    this.kbSends = 0;
  }
  async sendFeature(d) {
    this.log.push(d[0]);
    if (d[0] === 0xfb) {
      if (this.busyPolls > 0) { this.busyPolls--; this.out = Uint8Array.from([0, 66, 0, 0]); return; }
      if (this.stall && this.kbSends) { this.out = Uint8Array.from([0, 66, 0, 0]); return; }
      if (this.asleepPolls > 0) { this.asleepPolls--; this.out = Uint8Array.from([0, 73, 1, 0]); return; }
      const busy = this.pending-- > 0;
      this.out = Uint8Array.from([!busy && this.reply ? 1 : 0, 66, 0, busy ? 0 : 1]);
      return;
    }
    if (d[0] === 0xfc) { this.out = await this.kb.receiveFeature(); return; }
    if (d[0] === 0xfd) { this.out = Uint8Array.from([0xaa, 0x55, 1]); return; }
    this.kbSends++;
    this.pending = 2;
    this.reply = d[0] >= 0x80;
    await this.kb.sendFeature(d);
    this.out = new Uint8Array(64);
  }
  async receiveFeature() { const o = new Uint8Array(64); o.set(this.out.slice(0, 64)); return o; }
}

test('2.4 GHz receiver: queries wait for is_ready_read and fetch with 0xFC', async () => {
  const rx = new FakeReceiver();
  const kb = new Keyboard(rx, { dongle: true, rxPace: 0.05 });
  assert.deepEqual(await kb.getLinkStatus(), { linked: true, battery: 66 });
  assert.equal(await kb.getDeviceId(), 594);
  assert.equal(kb.battery, 66);
  const m = await kb.getKeyMatrix(0);
  assert.deepEqual(Array.from(m.slice(0, 4)), [0, 0, 41, 0]);
  assert.equal(rx.kbSends, 9);
});

test('2.4 GHz receiver: vendor order — FD, send, FD, then status polls', async () => {
  const rx = new FakeReceiver();
  const kb = new Keyboard(rx, { dongle: true, rxPace: 0.05 });
  await kb.getDeviceId();
  const cmd = rx.log.indexOf(0x8f);
  assert.equal(rx.log[cmd - 1], 0xfd);
  assert.equal(rx.log[cmd + 1], 0xfd);
  assert.equal(rx.log.at(-1), 0xfc);
});

test('2.4 GHz receiver: a lost command is not re-sent while the keyboard is busy', async () => {
  const rx = new FakeReceiver({ stall: true }); // never becomes idle again
  const kb = new Keyboard(rx, { dongle: true, rxPace: 0.05 });
  await assert.rejects(kb.setProfile(1), /still busy/);
  assert.equal(rx.kbSends, 1);
  assert.ok(rx.log.filter((c) => c === 0xfb).length <= 33, 'polls are bounded like the vendor (15 per wait)');
});

test('2.4 GHz receiver: a lost command is sent once more after the keyboard is idle', async () => {
  const rx = new FakeReceiver();
  const kb = new Keyboard(rx, { dongle: true, rxPace: 0.05 });
  const send = rx.sendFeature.bind(rx);
  let lost = false;
  rx.sendFeature = async (d) => {
    if (d[0] === 0x05 && !lost) { // the radio loses the first copy
      lost = true;
      rx.log.push(d[0]);
      rx.busyPolls = 16; // unconfirmed for longer than one 15-poll wait, then idle
      return;
    }
    return send(d);
  };
  await kb.setProfile(1);
  assert.equal(rx.log.filter((c) => c === 0x05).length, 2);
  assert.equal(rx.kbSends, 1, 'the keyboard received exactly one copy');
});

test('2.4 GHz receiver: waits for a write still in flight before sending', async () => {
  const rx = new FakeReceiver({ busyPolls: 4 });
  const kb = new Keyboard(rx, { dongle: true, rxPace: 0.05 });
  assert.equal(await kb.getDeviceId(), 594);
  assert.ok(rx.log.indexOf(0x8f) > 4, 'command sent only after the busy polls');
  assert.equal(rx.kbSends, 1);
});

test('2.4 GHz receiver: writes complete on is_write_finish (no reply expected)', async () => {
  const rx = new FakeReceiver();
  const kb = new Keyboard(rx, { dongle: true, rxPace: 0.05 });
  const m = Uint8Array.from(MODELS[1].matrix);
  m.set([3, 0, 111, 0], 48 * 4); // F8 -> brightness up
  await kb.setKeyMatrix(m, 0);
  assert.equal(rx.kbSends, 9);
  assert.deepEqual(Array.from(rx.kb.matrices[0].slice(48 * 4, 48 * 4 + 4)), [3, 0, 111, 0]);
});

test('2.4 GHz receiver: a persistently offline keyboard triggers onAsleep and continues once awake', async () => {
  const rx = new FakeReceiver({ asleepPolls: 1000 });
  const kb = new Keyboard(rx, { dongle: true, rxPace: 0.05 });
  const events = [];
  kb.onAsleep = (v) => events.push(v);
  assert.equal(await kb.getDeviceId(), 594);
  assert.deepEqual(events, [true, false]);
  assert.equal(rx.kbSends, 1);
});

test('2.4 GHz receiver: short offline blips are ignored (no prompt, no resend)', async () => {
  const rx = new FakeReceiver({ asleepPolls: 3 });
  const kb = new Keyboard(rx, { dongle: true, rxPace: 0.05 });
  const events = [];
  kb.onAsleep = (v) => events.push(v);
  assert.equal(await kb.getDeviceId(), 594);
  assert.deepEqual(events, []);
  // blip in the middle of a delivery
  const realSend = rx.sendFeature.bind(rx);
  let injected = false;
  rx.sendFeature = async (d) => { if (d[0] === 0x85 && !injected) { injected = true; await realSend(d); rx.asleepPolls = 2; return; } return realSend(d); };
  const before = rx.kbSends;
  assert.equal(await kb.getProfile(), 0);
  assert.equal(rx.kbSends - before, 1);
  assert.deepEqual(events, []);
});

test('2.4 GHz receiver: status is polled at the vendor pace (>= 100 ms apart)', async () => {
  const rx = new FakeReceiver();
  const times = [];
  const realSend = rx.sendFeature.bind(rx);
  rx.sendFeature = async (d) => { if (d[0] === 0xfb) times.push(performance.now()); return realSend(d); };
  const kb = new Keyboard(rx, { dongle: true });
  globalThis.setTimeout = realSetTimeout; // real timers for this test
  try {
    await kb.getDeviceId();
  } finally {
    globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms ?? 0, 1), ...a);
  }
  const gaps = times.slice(2).map((t, i) => t - times[i + 1]);
  assert.ok(gaps.length >= 1 && gaps.every((g) => g >= 95), `poll gaps ${gaps.map(Math.round)}`);
});

test('keycaps: icons for media/brightness, combo icon + pop-up keys, friendly unknowns', async () => {
  const { keycap } = await import('../web/js/keycap.js');
  const { icon } = await import('../web/js/icons.js');
  assert.equal(keycap([3, 0, 233, 0]).icon, 'volUp');
  assert.equal(keycap([3, 0, 234, 0]).icon, 'volDown');
  assert.equal(keycap([3, 0, 111, 0]).icon, 'brightUp');
  assert.equal(keycap([3, 0, 112, 0]).icon, 'brightDown');
  assert.equal(keycap([10, 15, 0, 0]).icon, 'knob');
  const combo = keycap([0, 226, 11, 0]);
  assert.equal(combo.icon, 'combo');
  assert.deepEqual(combo.pop.keys, ['Alt', 'H']);
  assert.deepEqual(keycap([0, 0, 227, 23]).pop.keys, ['L Win', 'T']); // win+T stored as key pair
  const raw = keycap([13, 2, 1, 0]);
  assert.equal(raw.icon, 'sparkle');
  assert.ok(!/[0-9a-f]{2} [0-9a-f]{2}/.test(raw.pop.text), 'no hex shown to users');
  assert.equal(keycap([0, 0, 0, 0], { fnLayer: true }).text, '');
  const mac = keycap([9, 1, 2, 0], { macroName: (slot) => (slot === 2 ? 'Login' : undefined) });
  assert.equal(mac.icon, 'macro');
  assert.equal(mac.pop.title, 'Login');
  assert.match(mac.pop.text, /toggle/);
  assert.equal(keycap([0, 0, 41, 0]).text, 'Esc');
  // every visible label fits on a 1u keycap; anything longer has a pop-up
  for (let hid = 4; hid <= 231; hid++) {
    const c = keycap([0, 0, hid, 0]);
    if ((c.text ?? '').length > 6) assert.ok(c.pop, `HID ${hid} label "${c.text}" needs a pop-up`);
  }
  for (const n of ['volUp', 'volDown', 'brightUp', 'brightDown', 'combo', 'sparkle', 'knob', 'rotateLeft', 'rotateRight', 'knobPress']) assert.ok(icon(n).startsWith('<svg'), n);
});

test('colour mode codes: PC75B Plus+ uses 7 = rainbow, 8 = solid; others keep vendor 8/7', () => {
  const plusPlus = MODELS.find((m) => m.ids.includes(594)).colourCodes;
  assert.deepEqual(plusPlus, { rainbow: 7, solid: 8 });
  const rb = Keyboard.encodeLight(7, { type: 'LightAlwaysOn', value: 4, rgb: 0x00ff00, dazzle: true }, true, plusPlus);
  const solid = Keyboard.encodeLight(7, { type: 'LightAlwaysOn', value: 4, rgb: 0x00ff00, dazzle: false }, true, plusPlus);
  assert.equal(rb[4] & 15, 7);
  assert.equal(solid[4] & 15, 8);
  assert.equal(Keyboard.decodeLight(rb, true, plusPlus).dazzle, true);
  assert.equal(Keyboard.decodeLight(solid, true, plusPlus).rgb, 0x00ff00);
  assert.equal(Keyboard.encodeLogoLight({ type: 'LightBreath', value: 4, speed: 2, rgb: 0xff0000, dazzle: true }, plusPlus)[4] & 15, 7);
  assert.equal(MODELS.find((m) => m.ids.includes(413)).colourCodes, undefined); // vendor default
  assert.equal(Keyboard.encodeLight(7, { type: 'LightAlwaysOn', value: 4, rgb: 1, dazzle: true }, true)[4] & 15, 8);
});

test('verified key-map write: rewrites once when the keyboard did not store it, errors after that', async () => {
  const { t, kb } = setup();
  const m = Uint8Array.from(MODELS[0].matrix);
  m.set([3, 0, 111, 0], 48 * 4);
  assert.equal(await kb.setKeyMatrixVerified(m, 0), 0); // stored first time
  // drop the first page once (simulates a link hiccup mid-write)
  const real = t.sendFeature.bind(t);
  let dropped = false;
  t.sendFeature = async (d) => { if (d[0] === CMD.SET_KEYMATRIX && d[4] === 0 && !dropped) { dropped = true; return; } return real(d); };
  m.set([0, 0, 57, 0], 0);
  assert.equal(await kb.setKeyMatrixVerified(m, 0), 1); // needed one rewrite
  assert.deepEqual(Array.from(t.matrices[0].slice(0, 4)), [0, 0, 57, 0]);
  // keyboard never stores it -> clear error
  t.sendFeature = async (d) => (d[0] === CMD.SET_KEYMATRIX ? undefined : real(d));
  m.set([0, 0, 58, 0], 0);
  await assert.rejects(kb.setKeyMatrixVerified(m, 0), /did not store the key map/);
});
