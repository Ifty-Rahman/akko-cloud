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
const RX_MAX_POLLS = 15; // the helper's wait_fb_write_finish / read_msg give up after 15 polls
const RX_EXTRA_POLLS = 8; // then a slow keyboard gets ~4 s more (only waiting, nothing is sent)
const RX_EXTRA_POLL_MS = 500;
const RX_LOOP_MS = 5000; // the helper's background status loop
const KEEP_ALIVE_MS = 30000; // optional keep-alive query (Settings); lights-off can be as short as 1 min
// macOS (see send / rxRequest / read): the receiver needs these small gaps
const RX_REPLY_DELAY_MS = 10; // vendor get_feature: wait this long before reading a reply
const RX_SEND_GAP_MS = 10; // vendor send_feature: at least this long between requests
const RX_REREAD_MS = 15; // gap before reading a stale receiver reply again

// commands whose reply starts with the command byte (seen on a PC75B Plus+)
const ECHOES = new Set([0x84, 0x85, 0x86, 0x87, 0x88, 0x8f, 0x91, 0x92]);
const NOT_LINKED = 'The 2.4 GHz receiver has no keyboard paired. Switch the keyboard to 2.4 GHz mode (or use the USB cable).';
const STILL_BUSY = 'The keyboard is still busy with the previous change. Wait a moment and try again.';
const NOT_ANSWERED = 'The keyboard did not answer over the 2.4 GHz receiver. Press any key on it and try again, or use the USB cable.';
const NOT_CONFIRMED = 'The keyboard did not confirm the change over the 2.4 GHz receiver. Press any key on it and try again, or use the USB cable.';

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
    this.inFlight = (this.inFlight ?? 0) + 1;
    const run = this.queue.then(fn, fn).finally(() => { this.inFlight--; });
    this.queue = run.catch(() => {});
    return run;
  }

  // One light query (the current profile) once nothing has run for a while.
  // Measured on a PC75B Plus+ on battery, lights-off set to 1 min: with a query
  // every 40 s it stayed on the receiver for 3 min; without, the link went down
  // within a minute (lights-off cuts it until a key press). Side effect: the
  // lights stay on as well. A keyboard that is already asleep is left alone.
  async keepAlive(idleMs = KEEP_ALIVE_MS) {
    if (!this.dongle || this.inFlight || Date.now() - (this.lastDoneAt ?? 0) < idleMs * this.rxPace) return false;
    const s = await this.exclusive(() => this.rxStatus());
    if (!s.online || this.inFlight) return false;
    this.onNote?.('keep-alive');
    await this.getProfile();
    return true;
  }

  async rawSend(bytes) {
    await this.send(packet(bytes));
  }

  // Every request over the receiver is at least RX_SEND_GAP_MS after the
  // previous one, like the vendor helper's send_feature (10 ms before each
  // send). The receiver holds one incoming request at a time: on macOS a link
  // check sent 1 ms after a command overwrote the command before the receiver
  // took it, and the command was silently lost (user's debug log).
  async send(data) {
    if (this.dongle) {
      const wait = (this.lastSendAt ?? 0) + RX_SEND_GAP_MS * this.rxPace - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastSendAt = Date.now();
    }
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
  // One request to the receiver itself ([FB] status, [FD] link check). The
  // vendor helper waits 10 ms before reading any reply (get_feature). On macOS
  // the receiver was seen answering an [FD] read 2 ms after the request with
  // its previous [FB] reply, so the link check failed ("no keyboard paired")
  // although the keyboard was connected. Wait like the vendor, and re-read
  // (the request is to the receiver only, so asking again is harmless) while
  // the reply is plainly still the previous one.
  async rxRequest(cmd, isFresh) {
    let r;
    for (let ask = 0; ask < 2; ask++) {
      await this.rawSend([cmd]);
      for (let read = 0; read < 3; read++) {
        await this.rxPoll(read ? RX_REREAD_MS : RX_REPLY_DELAY_MS);
        r = await this.rawRecv();
        if (isFresh(r)) return r;
      }
    }
    return r;
  }

  async rxStatus() {
    // a status reply never starts with the link check's AA 55
    const d = await this.rxRequest(RX.STATUS, (r) => !(r[0] === 0xaa && r[1] === 0x55));
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
  async ensureAwake(timeoutMs = 60000, graceMs = OFFLINE_GRACE_MS) {
    const t0 = Date.now();
    let s = await this.rxStatus();
    while (!s.online && Date.now() - t0 < graceMs * this.rxPace) {
      await this.rxPoll(RX_POLL_MS);
      s = await this.rxStatus();
    }
    if (s.online) return s;
    this.onAsleep?.(true);
    try {
      while (Date.now() - t0 < timeoutMs) {
        await this.rxPoll(RX_ASLEEP_POLL_MS);
        s = await this.rxStatus();
        if (s.online) return s;
      }
    } finally {
      this.onAsleep?.(false);
    }
    throw new KeyboardAsleepError();
  }

  // Tells the app when the keyboard is answering slowly (or fast again).
  // Without recent key presses the keyboard drifts into a slow power-saving
  // state; a key press on it switches it back to full speed.
  setSlow(slow) {
    if (!!this.slow === slow) return;
    this.slow = slow;
    this.onSlow?.(slow);
  }

  // [FD] -> AA 55 01 while a keyboard is paired with the receiver.
  async rxLinked() {
    const r = await this.rxRequest(RX.IS24, (x) => x[0] === 0xaa && x[1] === 0x55);
    return r[0] === 0xaa && r[1] === 0x55 && r[2] === 1;
  }

  // ---- the official driver's 2.4 GHz sequence ------------------------------
  // Copied from Akko's own helper (iot_driver, DJDevice::send_read_msg /
  // send_msg / read_msg / wait_fb_write_finish), which holds the connection on
  // the same keyboard and receiver. Plain receivers like 25a7:2420:
  //   send_read_msg: 10 ms, send_msg, 10 ms, read_msg (queries only)
  //   send_msg:      [FD], wait_fb_write_finish, send, [FD], wait_fb_write_finish
  //   read_msg:      [FD], up to 15 x (100 ms, [FB]) until is_ready_read, then
  //                  10 ms, [FC], 30 ms, read the reply
  //   wait_fb_write_finish: up to 15 x (100 ms, [FB]) until is_write_finish
  // Every request to the receiver waits 10 ms first (send_feature/get_feature).
  // Nothing is sent before the previous exchange has finished, and a command
  // is never sent twice.
  // Two additions, both of which only wait and send nothing to the keyboard:
  // after the vendor's 15 polls a slow keyboard gets a few more seconds, and a
  // keyboard that is off the receiver is waited for ("press any key").
  async waitFb(ready) {
    let offlineSince = null;
    for (let i = 0; i < RX_MAX_POLLS + RX_EXTRA_POLLS; i++) {
      if (i === RX_MAX_POLLS) this.setSlow(true);
      await this.rxPoll(i < RX_MAX_POLLS ? RX_POLL_MS : RX_EXTRA_POLL_MS);
      let s = await this.rxStatus();
      if (!s.online) {
        offlineSince ??= Date.now();
        i--; // offline polls don't use up the budget
        if (Date.now() - offlineSince < OFFLINE_GRACE_MS * this.rxPace) continue;
        s = await this.ensureAwake(60000, 0); // throws KeyboardAsleepError after a minute
      }
      offlineSince = null;
      if (ready(s)) {
        if (i < RX_MAX_POLLS) this.setSlow(false);
        return s;
      }
    }
    return null;
  }

  // A reply the receiver still holds from an exchange that was cut off (seen
  // after a failed connect: the keyboard-ID reply, unfetched). Left there, the
  // next query takes it as its own answer, and every answer after that is the
  // previous command's (the profile came back as 82 and the keyboard hung).
  // Fetching it ([FC]) only involves the receiver.
  async rxDrain() {
    await this.rawSend([RX.FETCH]);
    await this.rxPoll(30);
    const old = await this.rawRecv();
    this.onNote?.(`cleared a leftover reply (${old[0].toString(16).padStart(2, '0')}…) from the receiver`);
  }

  async sendDongle(data, expectReply) {
    if (!(await this.rxLinked())) throw new Error(NOT_LINKED);
    const idle = await this.waitFb((s) => s.writeFinish);
    if (!idle) throw new Error(STILL_BUSY);
    if (idle.readyRead) await this.rxDrain();
    await this.send(data);
    await this.rxLinked();
    let ok = await this.waitFb((s) => s.writeFinish);
    if (ok && expectReply) {
      await this.rxPoll(10);
      await this.rxLinked();
      ok = await this.waitFb((s) => s.readyRead);
    }
    this.lastDoneAt = Date.now();
    if (!ok) {
      this.onNote?.(`no ${expectReply ? 'reply' : 'confirmation'} from the keyboard`);
      throw new Error(expectReply ? NOT_ANSWERED : NOT_CONFIRMED);
    }
    this.done = (this.done ?? 0) + 1; // commands completed (progress bar)
  }

  // Run once when connecting over the receiver, like the helper's get_id:
  // [FD], then [FE 40] ("the next packet is 64 bytes", resetting any shorter
  // length left by an interrupted music or screen-sync stream), then 10 ms.
  rxInit() {
    return this.exclusive(async () => {
      const linked = await this.rxLinked();
      await this.rawSend([RX.NEXT_LEN, REPORT_LEN]);
      await this.rxPoll(10);
      if ((await this.rxStatus()).readyRead) await this.rxDrain();
      return linked;
    });
  }

  // The helper's background loop (handle_24_status): every 5 s while nothing
  // else runs, [FD] and [FB] to the receiver only, for the battery and link
  // state. It never talks to the keyboard itself.
  async rxBackgroundStatus() {
    const last = Math.max(this.lastDoneAt ?? 0, this.lastLoopAt ?? 0);
    if (!this.dongle || this.inFlight || Date.now() - last < RX_LOOP_MS * this.rxPace) return undefined;
    return this.exclusive(async () => {
      const linked = await this.rxLinked();
      const s = await this.rxStatus();
      this.lastLoopAt = Date.now();
      return { linked, online: s.online, battery: s.battery };
    });
  }

  // stream=true: fire-and-forget frames (music/screen), no link handshake.
  async write(bytes, checksum = Checksum.BIT7, preDelay = 10, stream = false, expectReply = false) {
    const data = applyChecksum(packet(bytes), checksum);
    await sleep(preDelay);
    if (this.dongle && !stream) return this.sendDongle(data, expectReply);
    await this.send(data);
    if (!stream) this.done = (this.done ?? 0) + 1; // commands completed (progress bar)
  }

  async read(preDelay = 5) {
    if (this.dongle) {
      // the helper's read_msg: 10 ms, fetch ([FC]), 30 ms, read the reply
      await this.rxPoll(10);
      await this.rawSend([RX.FETCH]);
      await this.rxPoll(30);
      return this.rawRecv();
    }
    await sleep(preDelay);
    return this.rawRecv();
  }

  // Receiver-level status: { linked, battery } (dongle only).
  getLinkStatus() {
    return this.exclusive(async () => {
      const linked = await this.rxLinked();
      const st = await this.rxStatus();
      this.battery = st.battery;
      return { linked, battery: st.battery };
    });
  }

  async query(bytes, checksum = Checksum.BIT7) {
    await this.write(bytes, checksum, 10, false, true);
    let r = await this.read();
    // Over the receiver, a reply to a single command starts with that command
    // (paged reads don't). One that doesn't belongs to an earlier exchange:
    // wait for the right one rather than use it.
    for (let n = 0; this.dongle && ECHOES.has(bytes[0]) && r[0] !== bytes[0]; n++) {
      if (n >= 2) throw new Error(NOT_ANSWERED);
      this.onNote?.(`reply ${r[0].toString(16).padStart(2, '0')} is not for ${bytes[0].toString(16)}: waiting for the right one`);
      if (!(await this.waitFb((s) => s.readyRead))) throw new Error(NOT_ANSWERED);
      r = await this.read();
    }
    return r;
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
  // Like the official app (_getKeyMatrix, _getFnKeyMatrix, getMacro,
  // _getLightPic): each page is asked for once. The receiver sequence waits
  // 30 ms before reading a fetched reply, which is what keeps replies whole.
  async readPaged(cmd, index, pages) {
    const out = new Uint8Array(pages * 64);
    for (let p = 0; p < pages; p++) out.set(await this.query([cmd, index, p]), p * 64);
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

  getKeyMatrix(profile = this.profile) {
    return this.exclusive(() => this.readPaged(CMD.GET_KEYMATRIX, profile, 8));
  }

  setKeyMatrix(matrix512, profile = this.profile) {
    return this.exclusive(() => this.writePaged(CMD.SET_KEYMATRIX, profile, matrix512, 9, 1000));
  }

  getFnMatrix(fnIndex) {
    return this.exclusive(() => this.readPaged(CMD.GET_FNMATRIX, fnIndex, 8));
  }

  setFnMatrix(matrix512, fnIndex) {
    return this.exclusive(() => this.writePaged(CMD.SET_FNMATRIX, fnIndex, matrix512, 9, 50));
  }

  // ---------------------------------------------------------- macros
  // Like the official getMacro: all 4 pages, each asked for once.
  getMacro(index) {
    return this.exclusive(async () => decodeMacro(await this.readPaged(CMD.GET_MACRO, index, 4)));
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
