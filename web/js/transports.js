// Transports deliver 64-byte feature reports (report ID 0) to the keyboard.
//   WebHidTransport  - keyboard plugged into the computer running the browser
//   DemoTransport    - simulated keyboard for trying the UI without hardware

import { USB_IDS, CONFIG_USAGE_PAGE, CONFIG_USAGE, isDongle } from './models.js';
import { CMD, REPORT_LEN } from './protocol.js';

const to64 = (view) => {
  const u8 = view instanceof DataView ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength) : Uint8Array.from(view);
  // Chromium returns the report ID as the first byte (65 bytes for report 0).
  const body = u8.length > REPORT_LEN ? u8.slice(u8.length - REPORT_LEN) : u8;
  const out = new Uint8Array(REPORT_LEN);
  out.set(body.slice(0, REPORT_LEN));
  return out;
};

const hasConfigCollection = (dev) =>
  dev.collections.some(
    (c) => c.usagePage === CONFIG_USAGE_PAGE && c.usage === CONFIG_USAGE && c.featureReports && c.featureReports.length > 0,
  );

export class WebHidTransport {
  static supported() {
    return typeof navigator !== 'undefined' && 'hid' in navigator && window.isSecureContext;
  }

  static filters() {
    return USB_IDS.map(({ vendorId, productId }) => ({ vendorId, productId, usagePage: CONFIG_USAGE_PAGE, usage: CONFIG_USAGE }));
  }

  static async request() {
    const devices = await navigator.hid.requestDevice({ filters: WebHidTransport.filters() });
    const dev = devices.find(hasConfigCollection) ?? devices[0];
    if (!dev) return undefined;
    return new WebHidTransport(dev);
  }

  static async previouslyGranted() {
    const devices = await navigator.hid.getDevices();
    const dev = devices.find((d) => USB_IDS.some((u) => u.vendorId === d.vendorId && u.productId === d.productId) && hasConfigCollection(d));
    return dev ? new WebHidTransport(dev) : undefined;
  }

  constructor(device) {
    this.device = device;
    this.vendorId = device.vendorId;
    this.productId = device.productId;
    this.name = device.productName || 'Keyboard';
    this.dongle = isDongle(device.vendorId, device.productId);
    this.kind = 'usb';
  }

  async open() {
    if (!this.device.opened) await this.device.open();
  }

  async close() {
    if (this.device.opened) await this.device.close();
  }

  onDisconnect(cb) {
    const h = (e) => {
      if (e.device === this.device) cb();
    };
    navigator.hid.addEventListener('disconnect', h);
  }

  async sendFeature(data64) {
    await this.device.sendFeatureReport(0, data64);
  }

  async receiveFeature() {
    return to64(await this.device.receiveFeatureReport(0));
  }
}

// In-memory keyboard implementing the same protocol, used by demo mode and tests.
export class DemoTransport {
  constructor(model) {
    this.vendorId = 0x3151;
    this.productId = 0x4003;
    this.name = 'Demo PC75B Plus';
    this.dongle = false;
    this.kind = 'demo';
    this.id = model.ids[0];
    this.profile = 0;
    this.matrices = [0, 1, 2, 3].map(() => Uint8Array.from(model.matrix));
    this.fn = [0, 1].map(() => new Uint8Array(512));
    this.macros = new Map();
    this.pic = new Uint8Array(384);
    this.led = [CMD.GET_LEDPARAM, 4, 2, 4, 8, 255, 0, 0];
    this.sled = [CMD.GET_SLEDPARAM, 1, 2, 4, 7, 0, 128, 255];
    this.kbopt = [0, 0, 0, 0, 0];
    this.rate = [8, 1, 1, 1];
    this.debounce = 5;
    this.sleep = [600, 600, 1800, 1800];
    this.pending = new Uint8Array(64);
    this.sent = [];
  }

  async open() {}
  async close() {}
  onDisconnect() {}

  async sendFeature(d) {
    this.sent.push(Uint8Array.from(d));
    const r = new Uint8Array(64);
    r[0] = d[0];
    const page = (buf, p) => r.set(buf.slice(p * 64, p * 64 + 64));
    const store = (buf, p) => buf.set(d.slice(8, 64).slice(0, Math.max(0, Math.min(56, buf.length - p * 56))), p * 56);
    switch (d[0]) {
      case CMD.GET_INFOR: r.set([this.id & 255, (this.id >> 8) & 255, (this.id >> 16) & 255, this.id >>> 24], 1); break;
      case CMD.GET_REV: r[1] = 0x12; r[2] = 0x01; break;
      case CMD.GET_PROFILE: r[1] = this.profile; break;
      case CMD.SET_PROFILE: this.profile = d[1]; break;
      case CMD.GET_REPORT: r[1] = d[1]; r[2] = this.rate[d[1]]; break;
      case CMD.SET_REPORT: this.rate[d[1]] = d[2]; break;
      case CMD.GET_KBOPTION: r[1] = d[1]; r.set(this.kbopt.slice(2, 5), 2); break;
      case CMD.SET_KBOPTION: this.kbopt = Array.from(d.slice(0, 5)); break;
      case CMD.GET_DEBOUNCE: r[2] = this.debounce; break;
      case CMD.SET_DEBOUNCE: this.debounce = d[2]; break;
      case CMD.GET_SLEEPTIME: this.sleep.forEach((v, i) => { r[1 + i * 2] = v & 255; r[2 + i * 2] = v >> 8; }); break;
      case CMD.SET_SLEEPTIME: this.sleep = [0, 1, 2, 3].map((i) => d[8 + i * 2] | (d[9 + i * 2] << 8)); break;
      case CMD.GET_LEDPARAM: r.set(this.led); break;
      case CMD.SET_LEDPARAM: this.led = [CMD.GET_LEDPARAM, ...d.slice(1, 8)]; break;
      case CMD.GET_SLEDPARAM: r.set(this.sled); break;
      case CMD.SET_SLEDPARAM: this.sled = [CMD.GET_SLEDPARAM, ...d.slice(1, 8)]; break;
      case CMD.GET_KEYMATRIX: page(this.matrices[d[1]], d[2]); break;
      case CMD.SET_KEYMATRIX: store(this.matrices[d[1]], d[4]); break;
      case CMD.GET_FNMATRIX: page(this.fn[d[1]], d[2]); break;
      case CMD.SET_FNMATRIX: store(this.fn[d[1]], d[4]); break;
      case CMD.GET_MACRO: page(this.macros.get(d[1]) ?? new Uint8Array(256), d[2]); break;
      case CMD.SET_MACRO: {
        const m = this.macros.get(d[1]) ?? new Uint8Array(280);
        if (d[4] === 0) m.fill(0);
        m.set(d.slice(8, 64), d[4] * 56);
        this.macros.set(d[1], m);
        break;
      }
      case CMD.GET_USERPIC: page(this.pic, d[2]); break;
      case CMD.SET_USERPIC: store(this.pic, d[4]); break;
      default: break;
    }
    this.pending = r;
  }

  async receiveFeature() {
    return this.pending;
  }
}
