// RongYuan "rongyuan_k_rgb" feature-report protocol as used by the Akko PC75B
// family. Every packet is a 64-byte feature report (HID report ID 0).
// Reverse engineered from Akko Cloud Driver 370.1.54 — see docs/PROTOCOL.md.

import { encodeMacro, decodeMacro, hexToRgb } from './codec.js';

export const REPORT_LEN = 64;

// Effective command values for the PC75B class chain (most-derived wins).
export const CMD = {
  SET_RESET: 0x02,
  SET_REPORT: 0x04,
  SET_PROFILE: 0x05,
  SET_KBOPTION: 0x06,
  SET_LEDPARAM: 0x07,
  SET_SLEDPARAM: 0x08,
  SET_KEYMATRIX: 0x09,
  SET_MACRO: 0x0b,
  SET_USERPIC: 0x0c,
  SET_AUDIO: 0x0d,
  SET_SCREEN: 0x0e,
  SET_FNMATRIX: 0x10,
  SET_DEBOUNCE: 0x11,
  SET_SLEEPTIME: 0x12,
  GET_REV: 0x80,
  GET_REPORT: 0x84,
  GET_PROFILE: 0x85,
  GET_KBOPTION: 0x86,
  GET_LEDPARAM: 0x87,
  GET_SLEDPARAM: 0x88,
  GET_KEYMATRIX: 0x89,
  GET_MACRO: 0x8b,
  GET_USERPIC: 0x8c,
  GET_INFOR: 0x8f,
  GET_FNMATRIX: 0x90,
  GET_DEBOUNCE: 0x91,
  GET_SLEEPTIME: 0x92,
};

// 2.4 GHz receiver commands (handled by the receiver itself, sent without checksum)
export const RX = {
  STATUS: 0xfb, // [0]=1 when the last packet reached the keyboard, [1]=battery %
  FETCH: 0xfc, // next feature read returns the keyboard's reply
  IS24: 0xfd, // replies aa 55 01 when a keyboard is linked
  NEXT_LEN: 0xfe, // announce length of the next streamed packet
};

// proto.driver.CheckSumType — applied by the vendor's native helper.
export const Checksum = { BIT7: 0, BIT8: 1, NONE: 2 };

const RX_POLL_MS = 100; // vendor pace for [FB] status polls
const RX_ASLEEP_POLL_MS = 500; // while waiting for a key press to wake the keyboard
const OFFLINE_GRACE_MS = 1200; // ignore shorter "offline" blips
const SETTLE_MS = 1000; // online this long after a wake before the first command
const SETTLE_MAX_MS = 8000;
const RX_MAX_POLLS = 15; // vendor: wait_fb_write_finish gives up after 15 polls

const NOT_LINKED = 'The 2.4 GHz receiver has no keyboard paired. Switch the keyboard to 2.4 GHz (Fn + Y), or hold Fn + Y to pair it again.';
const STILL_BUSY = 'The keyboard is still busy with the previous change. Wait a moment and try again.';
const NOT_ANSWERED = 'The keyboard did not answer over the 2.4 GHz receiver. Try again, or use the USB cable. If its green LED is blinking, switch it off and on.';
const INCONSISTENT_REPLY = 'The keyboard’s replies over the 2.4 GHz receiver did not agree, so nothing was changed. Try again, or use the USB cable.';
const NOT_CONFIRMED = 'The keyboard did not confirm the change over the 2.4 GHz receiver, so it may not have been saved. Try again, or use the USB cable. If its green LED is blinking, switch it off and on.';

const MAXSPEED = 4;
// Colour-mode nibble (low 4 bits of the option byte). The vendor driver uses
// 8 = rainbow, 7 = the RGB bytes; the PC75B Plus+ firmware was observed to use
// them the other way round, so models can override this (see models.js).
export const VENDOR_COLOUR_CODES = { rainbow: 8, solid: 7 };
const WAVEOP = { right: 0, left: 1, down: 2, up: 3 };
const MP = { upright: 0, separate: 1, intersect: 2 };
const USEROP = { 1: 0, 2: 16, 3: 32, 4: 48, 5: 64, 6: 80, 7: 96, 8: 112, 9: 128, 10: 144 };
const COMMONCOLOR = [0xff0000, 0xff8000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff];
const WHITE_SUBSTITUTE = 0xfafffa; // the driver never sends pure white

const RATE_CODES = { 1000: 1, 500: 2, 250: 4, 125: 8 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const keyOf = (obj, v) => Object.keys(obj).find((k) => obj[k] === v);

export class KeyboardAsleepError extends Error {
  constructor() {
    super('The keyboard is not answering. Press any key on it; if its green LED keeps blinking, switch it off and on again.');
    this.name = 'KeyboardAsleepError';
  }
}

export class IncompleteWriteError extends Error {
  constructor(what, cause) {
    super(`Writing the ${what} did not finish${cause ? ` (${cause.message.replace(/\.$/, '')})` : ''}. Some keys may not work until it is written again. Your changes are kept: press “Write to keyboard” again, ideally over the USB cable.`);
    this.name = 'IncompleteWriteError';
    this.cause = cause;
  }
}

export function applyChecksum(data, type) {
  if (type === Checksum.BIT7) {
    let s = 0;
    for (let i = 0; i < 7; i++) s += data[i];
    data[7] = 0xff - (s & 0xff);
  } else if (type === Checksum.BIT8) {
    let s = 0;
    for (let i = 0; i < 8; i++) s += data[i];
    data[8] = 0xff - (s & 0xff);
  }
  return data;
}

export function packet(bytes) {
  const p = new Uint8Array(REPORT_LEN);
  p.set(bytes.slice(0, REPORT_LEN));
  return p;
}

// Paged write header used by key-matrix / Fn-matrix uploads (checksum is
// computed by the driver itself and sent with CheckSumType NONE).
function pagedHeader(cmd, index, page) {
  const h = [cmd, index, 0xf8, 0x01, page, 0, 0, 0];
  let s = 0;
  for (let i = 0; i < 7; i++) s += h[i];
  h[7] = 0xff - (s & 0xff);
  return h;
}

export class Keyboard {
  constructor(transport, { dongle = false, log = () => {}, rxPace = 1 } = {}) {
    this.t = transport;
    this.dongle = dongle;
    this.log = log;
    this.profile = 0;
    this.queue = Promise.resolve();
    this.battery = undefined; // only known over the 2.4 GHz receiver
    this.rxPace = rxPace; // 1 = vendor timing; tests pass a small factor
    this.colourCodes = VENDOR_COLOUR_CODES; // set per model after identification
  }

  // Serialise all device traffic.
  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async rawSend(bytes) {
    const data = packet(bytes);
    this.log('→', data);
    await this.t.sendFeature(data);
  }

  async rawRecv() {
    const d = await this.t.receiveFeature();
    this.log('←', d);
    return d;
  }

  // 2.4 GHz receiver: poll 0xFB until byte 0 (write finished) is set.
  // Byte 1 carries the keyboard battery level in percent.
  // ---- 2.4 GHz receiver handshake ------------------------------------------
  // Status [FB] -> d[0] is_ready_read, d[1] battery %, d[2] 0 = keyboard online,
  // d[3] is_write_finish (field names from the vendor helper's DangleCommonStatus).
  async rxStatus() {
    await this.rawSend([RX.STATUS]);
    const d = await this.rawRecv();
    const s = { readyRead: d[0] === 1, battery: d[1], online: d[2] === 0, writeFinish: d[3] === 1, raw: d };
    if (s.online) this.battery = s.battery;
    return s;
  }

  // Receiver pacing. The vendor helper polls [FB] every 100 ms (wait_fb_write_finish,
  // up to 15 polls). Polling much faster (25 ms) was observed to make the 2.4 GHz
  // link drop and the keyboard lose its pairing (green LED blinking), so stay at
  // the vendor's pace. Single "offline" readings also occur transiently while the
  // radio retries, so offline only counts once it persists for OFFLINE_GRACE_MS.
  rxPoll(ms) {
    return sleep(Math.max(1, Math.round(ms * this.rxPace)));
  }

  // A sleeping keyboard cannot be woken by the receiver; only a key press does.
  async ensureAwake(timeoutMs = 60000) {
    const t0 = Date.now();
    let s = await this.rxStatus();
    if (s.online) return s;
    while (!s.online && Date.now() - t0 < OFFLINE_GRACE_MS * this.rxPace) {
      await this.rxPoll(RX_POLL_MS);
      s = await this.rxStatus();
    }
    if (s.online) return this.settle(s);
    this.onAsleep?.(true);
    try {
      while (Date.now() - t0 < timeoutMs) {
        await this.rxPoll(RX_ASLEEP_POLL_MS);
        s = await this.rxStatus();
        if (s.online) return await this.settle(s);
      }
    } finally {
      this.onAsleep?.(false);
    }
    throw new KeyboardAsleepError();
  }

  // Right after the keyboard wakes or re-links, commands were seen to take
  // seconds and then stall, dropping it off the receiver again. Wait until it
  // has reported online for a moment before talking to it.
  async settle(s) {
    const t0 = Date.now();
    let since = Date.now();
    while (Date.now() - since < SETTLE_MS * this.rxPace && Date.now() - t0 < SETTLE_MAX_MS * this.rxPace) {
      await this.rxPoll(RX_POLL_MS);
      s = await this.rxStatus();
      if (!s.online) since = Date.now();
    }
    return s;
  }

  // [FD] -> AA 55 01 while a keyboard is paired with the receiver.
  async rxLinked() {
    await this.rawSend([RX.IS24]);
    const r = await this.rawRecv();
    return r[0] === 0xaa && r[1] === 0x55 && r[2] === 1;
  }

  // The vendor helper's wait_fb_write_finish: at most RX_MAX_POLLS polls of
  // [FB], 100 ms apart. For queries the reply is ready when is_ready_read is set.
  async waitDelivered(expectReply) {
    let offlineSince = null;
    for (let i = 0; i < RX_MAX_POLLS; i++) {
      await this.rxPoll(RX_POLL_MS);
      const s = await this.rxStatus();
      if (!s.online) {
        offlineSince ??= Date.now();
        continue;
      }
      offlineSince = null;
      if (expectReply ? s.readyRead : s.writeFinish) return 'ok';
    }
    return offlineSince !== null ? 'offline' : 'timeout';
  }

  // One command over the receiver, in the vendor helper's order (send_msg):
  // link check, wait until the previous write has finished, send, link check,
  // wait for delivery. Single packets are occasionally lost over the radio; a
  // lost one is sent once more, but only after the receiver reports the
  // keyboard idle again (re-sending while it was still busy made it drop off).
  async sendDongle(data, expectReply) {
    for (let attempt = 0; ; attempt++) {
      // wait_fb_write_finish starts with a 100 ms sleep, so the vendor never
      // sends sooner than that after the previous exchange. Commands sent
      // ~20 ms after a reply was fetched were seen to go unacknowledged.
      await this.rxPoll(RX_POLL_MS);
      let s = await this.ensureAwake();
      if (!(await this.rxLinked())) throw new Error(NOT_LINKED);
      for (let i = 0; !s.writeFinish && !s.readyRead && i < RX_MAX_POLLS; i++) {
        await this.rxPoll(RX_POLL_MS);
        s = await this.rxStatus();
      }
      if (!s.online) continue; // fell asleep while we waited: ensureAwake prompts for a key press
      if (!s.writeFinish && !s.readyRead) throw new Error(STILL_BUSY);
      this.log('→', data);
      await this.t.sendFeature(data);
      await this.rxLinked();
      const r = await this.waitDelivered(expectReply);
      if (r === 'ok') return;
      if (attempt >= 1) throw r === 'offline' ? new KeyboardAsleepError() : new Error(expectReply ? NOT_ANSWERED : NOT_CONFIRMED);
    }
  }

  // stream=true: fire-and-forget frames (music/screen), no link handshake.
  async write(bytes, checksum = Checksum.BIT7, preDelay = 10, stream = false, expectReply = false) {
    const data = applyChecksum(packet(bytes), checksum);
    await sleep(preDelay);
    if (this.dongle && !stream) return this.sendDongle(data, expectReply);
    this.log('→', data);
    await this.t.sendFeature(data);
  }

  async read(preDelay = 5) {
    await sleep(preDelay);
    if (this.dongle) await this.rawSend([RX.FETCH]); // ask the receiver for the keyboard's reply
    return this.rawRecv();
  }

  // Receiver-level status: { linked, battery } (dongle only).
  getLinkStatus() {
    return this.exclusive(async () => {
      await this.rawSend([RX.IS24]);
      const r = await this.rawRecv();
      await this.rawSend([RX.STATUS]);
      const st = await this.rawRecv();
      this.battery = st[1];
      return { linked: r[0] === 0xaa && r[1] === 0x55 && r[2] === 1, battery: st[1] };
    });
  }

  async query(bytes, checksum = Checksum.BIT7) {
    await this.write(bytes, checksum, 10, false, true);
    return this.read();
  }

  // ---------------------------------------------------------- identity
  getDeviceId() {
    return this.exclusive(async () => {
      const r = await this.query([CMD.GET_INFOR]);
      return (r[1] | (r[2] << 8) | (r[3] << 16) | (r[4] << 24)) >>> 0;
    });
  }

  getFirmwareVersion() {
    return this.exclusive(async () => {
      const r = await this.query([CMD.GET_REV]);
      return r[1] | (r[2] << 8);
    });
  }

  // ---------------------------------------------------------- profiles
  getProfile() {
    return this.exclusive(async () => {
      const r = await this.query([CMD.GET_PROFILE]);
      this.profile = r[1];
      return r[1];
    });
  }

  setProfile(p) {
    return this.exclusive(async () => {
      await this.write([CMD.SET_PROFILE, p]);
      this.profile = p;
    });
  }

  factoryReset() {
    return this.exclusive(async () => {
      await this.write([CMD.SET_RESET]);
      await sleep(1000);
    });
  }

  // ---------------------------------------------------------- report rate
  getReportRate() {
    return this.exclusive(async () => {
      const r = await this.query([CMD.GET_REPORT, this.profile]);
      return Number(keyOf(RATE_CODES, r[2])) || undefined;
    });
  }

  setReportRate(hz) {
    return this.exclusive(async () => {
      await this.write([CMD.SET_REPORT, this.profile, RATE_CODES[hz] ?? 0]);
      await sleep(1000);
    });
  }

  // ---------------------------------------------------------- options
  getKeyboardOption() {
    return this.exclusive(async () => {
      const r = await this.query([CMD.GET_KBOPTION, this.profile]);
      const n = r[2];
      return {
        raw: n,
        winKeyLock: !!(n & 1),
        macMode: !!(n & 2),
        wasdArrowSwap: !!(n & 8),
        ledOff: !!(n & 16),
        logoLedOff: !!(n & 32),
        keyboardMode: !!(n & 64),
        keyboardLock: !!(n & 128),
        fnMatrix: !!(r[3] & 1),
        powerSave: !!r[4],
      };
    });
  }

  // Read-modify-write: bits this UI does not edit (1, 2) are preserved.
  setKeyboardOption(o) {
    return this.exclusive(async () => {
      const b =
        (o.raw & 0b110) |
        (o.winKeyLock ? 1 : 0) |
        (o.wasdArrowSwap ? 8 : 0) |
        (o.ledOff ? 16 : 0) |
        (o.logoLedOff ? 32 : 0) |
        (o.keyboardMode ? 64 : 0) |
        (o.keyboardLock ? 128 : 0);
      await this.write([CMD.SET_KBOPTION, this.profile, b, o.fnMatrix ? 1 : 0, o.powerSave ? 1 : 0]);
    });
  }

  getDebounce() {
    return this.exclusive(async () => (await this.query([CMD.GET_DEBOUNCE]))[2]);
  }

  setDebounce(v) {
    return this.exclusive(async () => {
      await this.write([CMD.SET_DEBOUNCE, 0, v]);
      await sleep(500);
    });
  }

  // Times in seconds; 0 disables that sleep stage.
  getSleepTime() {
    return this.exclusive(async () => {
      const a = await this.query([CMD.GET_SLEEPTIME]);
      const u16 = (i) => a[i] | (a[i + 1] << 8);
      return { bt: u16(1), rf: u16(3), deepBt: u16(5), deepRf: u16(7) };
    });
  }

  setSleepTime(s) {
    return this.exclusive(async () => {
      const a = new Array(16).fill(0);
      a[0] = CMD.SET_SLEEPTIME;
      [s.bt, s.rf, s.deepBt, s.deepRf].forEach((v, i) => {
        a[8 + i * 2] = v & 0xff;
        a[9 + i * 2] = (v >> 8) & 0xff;
      });
      await this.write(a);
      await sleep(500);
    });
  }

  // ---------------------------------------------------------- lighting
  static encodeLight(cmd, l, invertSpeed, codes = VENDOR_COLOUR_CODES) {
    const y = l.dazzle ? codes.rainbow : codes.solid;
    const c = l.dazzle ? 0 : 4;
    let n = 0;
    let o = 0;
    let u = 0;
    let i = 7;
    const v = l.value ?? 4;
    const sp = l.speed ?? 2;
    const dir2 = (first) => (l.option === undefined || l.option === first ? y : 16 | y);
    const music = () => (l.option === undefined || l.option === 'upright' ? c : (MP[l.option] << 4) | c);
    switch (l.type) {
      case 'LightOff': n = 0; break;
      case 'LightAlwaysOn': n = 1; u = v; i = y; break;
      case 'LightBreath': n = 2; o = sp; u = v; i = y; break;
      case 'LightNeon': n = 3; o = sp; u = v; break;
      case 'LightWave': n = 4; o = sp; u = v; i = ((WAVEOP[l.option] ?? 0) << 4) | y; break;
      case 'LightRipple': n = 5; o = sp; u = v; i = y; break;
      case 'LightRaindrop': n = 6; o = sp; u = v; i = y; break;
      case 'LightSnake': n = 7; o = sp; u = v; i = dir2('z'); break;
      case 'LightPressAction': n = 8; o = sp; u = v; i = y; break;
      case 'LightConverage': n = 9; o = sp; u = v; i = y; break;
      case 'LightSineWave': n = 10; o = sp; u = v; i = y; break;
      case 'LightKaleidoscope': n = 11; o = sp; u = v; i = dir2('out'); break;
      case 'LightLineWave': n = 12; o = sp; u = v; i = dir2('right'); break;
      case 'LightUserPicture': n = 13; i = USEROP[l.option] ?? 0; u = v; break;
      case 'LightLaser': n = 14; o = sp; u = v; i = y; break;
      case 'LightCircleWave': n = 15; o = sp; u = v; i = dir2('anti-clockwise'); break;
      case 'LightDazzing': n = 16; o = sp; u = v; i = y; break;
      case 'LightRainDown': n = 17; o = sp; u = v; i = y; break;
      case 'LightMeteor': n = 18; o = sp; u = v; i = y; break;
      case 'LightPressActionOff': n = 19; o = sp; u = v; i = y; break;
      case 'LightMusicFollow3': n = 20; u = v; i = music(); break;
      case 'LightScreenColor': n = 21; u = 4; break;
      case 'LightMusicFollow2': n = 22; u = v; i = music(); break;
      case 'LightTrain': n = 23; o = sp; u = v; i = y; break;
      case 'LightFireWorks': n = 24; o = sp; u = v; i = dir2('right'); break;
      case 'LightUserColor': n = 66; break;
      default: throw new Error('unknown light type ' + l.type);
    }
    const a = new Array(9).fill(0);
    a[0] = cmd;
    a[1] = n;
    a[2] = invertSpeed ? MAXSPEED - o : o;
    a[3] = u;
    a[4] = i;
    if (l.rgb !== undefined) {
      const rgb = l.rgb === 0xffffff ? WHITE_SUBSTITUTE : l.rgb;
      a[5] = (rgb >> 16) & 255;
      a[6] = (rgb >> 8) & 255;
      a[7] = rgb & 255;
    }
    if (l.type === 'LightUserPicture') {
      a[5] = 0;
      a[6] = 200;
      a[7] = 200;
    }
    return a;
  }

  static decodeLight(a, invertSpeed, codes = VENDOR_COLOUR_CODES) {
    const n = a[1];
    const o = invertSpeed ? MAXSPEED - a[2] : a[2];
    const u = a[3];
    const i = a[4];
    let rgb = (a[5] << 16) | (a[6] << 8) | a[7];
    if (rgb === WHITE_SUBSTITUTE) rgb = 0xffffff;
    const y = i >> 4;
    const c = i & 15;
    if (c !== codes.rainbow && c !== codes.solid && COMMONCOLOR[c] !== undefined) rgb = COMMONCOLOR[c];
    const dazzle = c === codes.rainbow;
    const base = { value: u, speed: o, rgb, dazzle };
    const pick = (a0, a1) => (y === 0 ? a0 : a1);
    switch (n) {
      case 0: return { type: 'LightOff' };
      case 1: return { type: 'LightAlwaysOn', value: u, rgb, dazzle };
      case 2: return { type: 'LightBreath', ...base };
      case 3: return { type: 'LightNeon', value: u, speed: o };
      case 4: return { type: 'LightWave', ...base, option: keyOf(WAVEOP, y) ?? 'right' };
      case 5: return { type: 'LightRipple', ...base };
      case 6: return { type: 'LightRaindrop', ...base };
      case 7: return { type: 'LightSnake', ...base, option: pick('z', 'return') };
      case 8: return { type: 'LightPressAction', ...base };
      case 9: return { type: 'LightConverage', ...base };
      case 10: return { type: 'LightSineWave', ...base };
      case 11: return { type: 'LightKaleidoscope', ...base, option: pick('out', 'in') };
      case 12: return { type: 'LightLineWave', ...base, option: pick('right', 'left') };
      case 13: return { type: 'LightUserPicture', value: u, option: keyOf(USEROP, i) ?? '1' };
      case 14: return { type: 'LightLaser', ...base };
      case 15: return { type: 'LightCircleWave', ...base, option: pick('anti-clockwise', 'clockwise') };
      case 16: return { type: 'LightDazzing', ...base };
      case 17: return { type: 'LightRainDown', ...base };
      case 18: return { type: 'LightMeteor', ...base };
      case 19: return { type: 'LightPressActionOff', ...base };
      case 20: return { type: 'LightMusicFollow3', value: u, option: keyOf(MP, y) ?? 'upright', rgb, dazzle: c === 0 };
      case 21: return { type: 'LightScreenColor', value: 4 };
      case 22: return { type: 'LightMusicFollow2', value: u, option: keyOf(MP, y) ?? 'upright', rgb, dazzle: c === 0 };
      case 23: return { type: 'LightTrain', ...base };
      case 24: return { type: 'LightFireWorks', ...base, option: pick('right', 'left') };
      case 66: return { type: 'LightUserColor' };
      default: return { type: 'Unknown', mode: n };
    }
  }

  getLight() {
    return this.exclusive(async () => Keyboard.decodeLight(await this.query([CMD.GET_LEDPARAM]), true, this.colourCodes));
  }

  setLight(l) {
    return this.exclusive(async () => {
      await this.write(Keyboard.encodeLight(CMD.SET_LEDPARAM, l, true, this.colourCodes), Checksum.BIT8, 500);
      await sleep(500);
    });
  }

  // Logo/side LED ("SLED"): own mode numbering, speed is not inverted.
  static encodeLogoLight(l, codes = VENDOR_COLOUR_CODES) {
    const y = l.dazzle ? codes.rainbow : codes.solid;
    const v = l.value ?? 4;
    const sp = l.speed ?? 2;
    let n = 0;
    let o = 0;
    let u = 0;
    let i = 7;
    switch (l.type) {
      case 'LightOff': n = 0; break;
      case 'LightAlwaysOn': n = 1; u = v; i = y; break;
      case 'LightBreath': n = 2; o = sp; u = v; i = y; break;
      case 'LightNeon': n = 3; o = sp; u = v; break;
      case 'LightWave': n = 4; o = sp; u = v; i = ((WAVEOP[l.option] ?? WAVEOP.right) << 4) | y; break;
      case 'LightSnake': n = 5; o = sp; u = v; i = l.option === undefined || l.option === 'z' ? y : 16 | y; break;
      default: throw new Error('unsupported LED strip effect ' + l.type);
    }
    const a = [CMD.SET_SLEDPARAM, n, o, u, i, 0, 0, 0];
    if (l.rgb !== undefined) {
      const rgb = l.rgb === 0xffffff ? WHITE_SUBSTITUTE : l.rgb;
      a[5] = (rgb >> 16) & 255;
      a[6] = (rgb >> 8) & 255;
      a[7] = rgb & 255;
    }
    return a;
  }

  static decodeLogoLight(a, codes = VENDOR_COLOUR_CODES) {
    const [, n, o, u, i] = a;
    let rgb = (a[5] << 16) | (a[6] << 8) | a[7];
    if (rgb === WHITE_SUBSTITUTE) rgb = 0xffffff;
    const c = i & 15;
    const y = i >> 4;
    if (c !== codes.rainbow && c !== codes.solid && COMMONCOLOR[c] !== undefined) rgb = COMMONCOLOR[c];
    const base = { value: u, speed: o, rgb, dazzle: c === codes.rainbow };
    switch (n) {
      case 0: return { type: 'LightOff' };
      case 1: return { type: 'LightAlwaysOn', value: u, rgb, dazzle: c === codes.rainbow };
      case 2: return { type: 'LightBreath', ...base };
      case 3: return { type: 'LightNeon', value: u, speed: o };
      case 4: return { type: 'LightWave', ...base, option: keyOf(WAVEOP, y) ?? 'right' };
      case 5: return { type: 'LightSnake', ...base, option: y === 0 ? 'z' : 'return' };
      default: return { type: 'Unknown', mode: n };
    }
  }

  getLogoLight() {
    return this.exclusive(async () => Keyboard.decodeLogoLight(await this.query([CMD.GET_SLEDPARAM]), this.colourCodes));
  }

  setLogoLight(l) {
    return this.exclusive(async () => {
      await this.write(Keyboard.encodeLogoLight(l, this.colourCodes), Checksum.BIT8, 500);
      await sleep(500);
    });
  }

  // Per-key colours: Uint8Array(384) = 128 matrix slots x RGB.
  getUserPicture() {
    return this.exclusive(async () => {
      const out = new Uint8Array(384);
      for (let p = 0; p < 6; p++) out.set(await this.query([CMD.GET_USERPIC, 0, p]), p * 64);
      return out;
    });
  }

  setUserPicture(rgb384) {
    return this.exclusive(async () => {
      const len = 64 * 6;
      for (let p = 0; p < 7; p++) {
        const chunk = Array.from(rgb384.slice(56 * p, 56 * p + 56));
        while (chunk.length < 56) chunk.push(0);
        await this.write([CMD.SET_USERPIC, 0, len & 0xff, len >> 8, p, 0, 0, 0, ...chunk], Checksum.BIT7, 20);
      }
      await sleep(1000);
    });
  }

  // Host-driven effects (music rhythm / screen colour sync)
  // Over the receiver the original driver announces the packet length (0xFE)
  // and packs two 4-bit levels per byte; over USB it sends one byte per level.
  sendMusicFrame(levels32) {
    return this.exclusive(async () => {
      const lv = levels32.slice(0, 32);
      if (this.dongle) {
        await this.rawSend([RX.NEXT_LEN, lv.length / 2 + 1]);
        await sleep(10);
        const p = [CMD.SET_AUDIO];
        for (let c = 0; c < lv.length / 2; c++) p.push(lv[2 * c] | (lv[2 * c + 1] << 4));
        await this.write(p, Checksum.NONE, 0, true);
      } else {
        const head = [CMD.SET_AUDIO, 0, 0, 0, 0, 0, 0, 0xff - CMD.SET_AUDIO];
        await this.write([...head, ...lv], Checksum.BIT7, 0, true);
      }
    });
  }

  sendScreenColor(r, g, b, a = 255) {
    return this.exclusive(async () => {
      if (this.dongle) {
        await this.rawSend([RX.NEXT_LEN, 8]);
        await sleep(10);
      }
      await this.write([CMD.SET_SCREEN, r, g, b, a], Checksum.BIT7, 0, true);
    });
  }

  // ---------------------------------------------------------- key matrices
  // Over the receiver a reply is occasionally wrong although the receiver
  // reported it ready: a 16-byte block missing (zeros) or another page's data.
  // Seen on a PC75B Plus+: keys 12-15 of a key-map read came back as 0 and
  // were shown as disabled. Each page is therefore checked against `ref` (the
  // last known contents, e.g. the cached map or the data just written): a page
  // that matches is accepted, a page that differs is read again and accepted
  // once two reads agree. Without `ref` every page is read twice.
  async readPaged(cmd, index, pages, ref) {
    const out = new Uint8Array(pages * 64);
    if (ref) {
      const full = new Uint8Array(pages * 64); // model maps can be shorter than the pages read
      full.set(Array.from(ref).slice(0, pages * 64));
      ref = full;
    }
    for (let p = 0; p < pages; p++) {
      const q = () => this.query([cmd, index, p]);
      const want = ref?.subarray(p * 64, p * 64 + 64);
      let page = await q();
      if (this.dongle && !(want && sameBytes(page, want))) {
        for (let n = 0; ; n++) {
          const again = await q();
          if (sameBytes(again, page)) break; // the same twice
          page = again;
          if (want && sameBytes(page, want)) break; // matches what we expected
          if (n >= 2) throw new Error(INCONSISTENT_REPLY);
        }
      }
      out.set(page, p * 64);
    }
    return out;
  }

  async writePaged(cmd, index, data, pages, gap) {
    for (let p = 0; p < pages; p++) {
      const chunk = Array.from(data.slice(56 * p, 56 * p + 56));
      while (chunk.length < 56) chunk.push(0);
      await this.write([...pagedHeader(cmd, index, p), ...chunk], Checksum.NONE);
    }
    await sleep(gap);
  }

  getKeyMatrix(profile = this.profile, ref) {
    return this.exclusive(() => this.readPaged(CMD.GET_KEYMATRIX, profile, 8, ref));
  }

  setKeyMatrix(matrix512, profile = this.profile) {
    return this.exclusive(() => this.writePaged(CMD.SET_KEYMATRIX, profile, matrix512, 9, 1000));
  }

  // Write, read back and compare. A paged upload that was cut off part way
  // (link drop) or did not store correctly is redone in full once: a partial
  // upload leaves the keys of the missing pages disabled.
  async verifiedWrite(write, read, data, what, n = 9 * 56 /* bytes the paged upload carries */) {
    let interrupted;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await write();
        const back = await read();
        if (data.slice(0, n).every((v, i) => v === back[i])) return attempt;
        interrupted = undefined;
      } catch (e) {
        interrupted = e;
        if (e instanceof KeyboardAsleepError) break; // nobody pressed a key for a minute
      }
    }
    throw new IncompleteWriteError(what, interrupted);
  }

  setKeyMatrixVerified(matrix512, profile = this.profile) {
    return this.verifiedWrite(() => this.setKeyMatrix(matrix512, profile), () => this.getKeyMatrix(profile, matrix512), matrix512, 'key map');
  }

  setFnMatrixVerified(matrix512, fnIndex) {
    return this.verifiedWrite(() => this.setFnMatrix(matrix512, fnIndex), () => this.getFnMatrix(fnIndex, matrix512), matrix512, 'Fn layer');
  }

  getFnMatrix(fnIndex, ref) {
    return this.exclusive(() => this.readPaged(CMD.GET_FNMATRIX, fnIndex, 8, ref));
  }

  setFnMatrix(matrix512, fnIndex) {
    return this.exclusive(() => this.writePaged(CMD.SET_FNMATRIX, fnIndex, matrix512, 9, 50));
  }

  // ---------------------------------------------------------- macros
  getMacroRaw(index, ref) {
    return this.exclusive(() => this.readPaged(CMD.GET_MACRO, index, 4, ref));
  }

  // First page only: enough to tell whether a slot holds a macro.
  getMacroHead(index) {
    return this.exclusive(() => this.query([CMD.GET_MACRO, index, 0]));
  }

  async getMacro(index) {
    return decodeMacro(await this.getMacroRaw(index));
  }

  setMacroVerified(index, events, repeatCount = 1) {
    const buf = encodeMacro(events, repeatCount);
    return this.verifiedWrite(() => this.setMacro(index, events, repeatCount), () => this.getMacroRaw(index, buf), buf, 'macro', buf.length);
  }

  setMacro(index, events, repeatCount = 1) {
    const buf = encodeMacro(events, repeatCount);
    return this.exclusive(async () => {
      for (let p = 0; p < 5; p++) {
        const chunk = Array.from(buf.slice(56 * p, 56 * p + 56));
        while (chunk.length < 56) chunk.push(0);
        await this.write([CMD.SET_MACRO, index, 0, 1, p, 0, 0, 0, ...chunk], Checksum.BIT7);
      }
      await sleep(1000);
    });
  }
}

export { hexToRgb };
