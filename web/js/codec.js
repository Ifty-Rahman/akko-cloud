// Encoders/decoders for key actions, macros and colours, ported from the
// Akko Cloud Driver ("pC"/"sC" key codecs, "setMacro"/"buffToMacroEvents").

// ---- HID keyboard usages -------------------------------------------------
export const HID_NAMES = {
  4: 'A', 5: 'B', 6: 'C', 7: 'D', 8: 'E', 9: 'F', 10: 'G', 11: 'H', 12: 'I', 13: 'J',
  14: 'K', 15: 'L', 16: 'M', 17: 'N', 18: 'O', 19: 'P', 20: 'Q', 21: 'R', 22: 'S', 23: 'T',
  24: 'U', 25: 'V', 26: 'W', 27: 'X', 28: 'Y', 29: 'Z',
  30: '1', 31: '2', 32: '3', 33: '4', 34: '5', 35: '6', 36: '7', 37: '8', 38: '9', 39: '0',
  40: 'Enter', 41: 'Esc', 42: 'Backspace', 43: 'Tab', 44: 'Space', 45: '-', 46: '=', 47: '[',
  48: ']', 49: '\\', 50: 'ISO #', 51: ';', 52: "'", 53: '`', 54: ',', 55: '.', 56: '/',
  57: 'Caps Lock', 58: 'F1', 59: 'F2', 60: 'F3', 61: 'F4', 62: 'F5', 63: 'F6', 64: 'F7',
  65: 'F8', 66: 'F9', 67: 'F10', 68: 'F11', 69: 'F12', 70: 'Print Screen', 71: 'Scroll Lock',
  72: 'Pause', 73: 'Insert', 74: 'Home', 75: 'Page Up', 76: 'Delete', 77: 'End', 78: 'Page Down',
  79: 'Right', 80: 'Left', 81: 'Down', 82: 'Up', 83: 'Num Lock', 84: 'KP /', 85: 'KP *',
  86: 'KP -', 87: 'KP +', 88: 'KP Enter', 89: 'KP 1', 90: 'KP 2', 91: 'KP 3', 92: 'KP 4',
  93: 'KP 5', 94: 'KP 6', 95: 'KP 7', 96: 'KP 8', 97: 'KP 9', 98: 'KP 0', 99: 'KP .',
  100: 'ISO \\', 101: 'Menu', 103: 'KP =', 104: 'F13', 105: 'F14', 106: 'F15', 107: 'F16',
  108: 'F17', 109: 'F18', 110: 'F19', 111: 'F20', 112: 'F21', 113: 'F22', 114: 'F23', 115: 'F24',
  135: 'Intl Ro', 136: 'Kana', 137: 'Yen', 138: 'Henkan', 139: 'Muhenkan', 144: 'Lang 1', 145: 'Lang 2',
  224: 'L Ctrl', 225: 'L Shift', 226: 'L Alt', 227: 'L Win', 228: 'R Ctrl', 229: 'R Shift',
  230: 'R Alt', 231: 'R Win',
};

export const SHORT_NAMES = {
  40: 'Enter', 41: 'Esc', 42: 'Bksp', 43: 'Tab', 57: 'Caps', 70: 'PrtSc', 71: 'ScrLk',
  73: 'Ins', 74: 'Home', 75: 'PgUp', 76: 'Del', 77: 'End', 78: 'PgDn', 79: '→', 80: '←',
  81: '↓', 82: '↑', 224: 'Ctrl', 225: 'Shift', 226: 'Alt', 227: 'Win', 228: 'Ctrl',
  229: 'Shift', 230: 'Alt', 231: 'Win', 44: '', 101: 'Menu', 83: 'NumLk', 72: 'Pause',
  88: 'KP Ent', 135: 'Ro', 139: 'Muhen', 138: 'Henk',
};

// KeyboardEvent.code -> HID usage (for "press a key" capture and macro recording)
export const CODE_TO_HID = (() => {
  const m = {};
  for (let i = 0; i < 26; i++) m['Key' + String.fromCharCode(65 + i)] = 4 + i;
  for (let i = 1; i <= 9; i++) m['Digit' + i] = 29 + i;
  m.Digit0 = 39;
  for (let i = 1; i <= 12; i++) m['F' + i] = 57 + i;
  for (let i = 13; i <= 24; i++) m['F' + i] = 91 + i;
  Object.assign(m, {
    Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46,
    BracketLeft: 47, BracketRight: 48, Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53,
    Comma: 54, Period: 55, Slash: 56, CapsLock: 57, PrintScreen: 70, ScrollLock: 71, Pause: 72,
    Insert: 73, Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78, ArrowRight: 79,
    ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85,
    NumpadSubtract: 86, NumpadAdd: 87, NumpadEnter: 88, Numpad1: 89, Numpad2: 90, Numpad3: 91,
    Numpad4: 92, Numpad5: 93, Numpad6: 94, Numpad7: 95, Numpad8: 96, Numpad9: 97, Numpad0: 98,
    NumpadDecimal: 99, IntlBackslash: 100, ContextMenu: 101, NumpadEqual: 103,
    ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227, OSLeft: 227,
    ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231, OSRight: 231,
  });
  return m;
})();

// ---- Special actions (tables MF/TF/MC from the original driver) ----------
// Only actions the keyboard executes on its own are listed; actions that need
// the vendor's desktop helper (launch app, mic mute, open website...) are not.
export const FUNCTION_ACTIONS = [
  { group: 'Media', label: 'Play / Pause', bytes: [3, 0, 205, 0] },
  { group: 'Media', label: 'Next track', bytes: [3, 0, 181, 0] },
  { group: 'Media', label: 'Previous track', bytes: [3, 0, 182, 0] },
  { group: 'Media', label: 'Stop', bytes: [3, 0, 183, 0] },
  { group: 'Media', label: 'Mute', bytes: [3, 0, 226, 0] },
  { group: 'Media', label: 'Volume up', bytes: [3, 0, 233, 0] },
  { group: 'Media', label: 'Volume down', bytes: [3, 0, 234, 0] },
  { group: 'Media', label: 'Media player', bytes: [3, 0, 131, 1] },
  { group: 'System', label: 'Brightness up', bytes: [3, 0, 111, 0] },
  { group: 'System', label: 'Brightness down', bytes: [3, 0, 112, 0] },
  { group: 'System', label: 'Calculator', bytes: [3, 0, 146, 1] },
  { group: 'System', label: 'Mail', bytes: [3, 0, 138, 1] },
  { group: 'System', label: 'My computer', bytes: [3, 0, 148, 1] },
  { group: 'System', label: 'Browser search', bytes: [3, 0, 33, 2] },
  { group: 'System', label: 'Browser home', bytes: [3, 0, 35, 2] },
  { group: 'System', label: 'Browser back', bytes: [3, 0, 36, 2] },
  { group: 'System', label: 'Browser refresh', bytes: [3, 0, 39, 2] },
  { group: 'System', label: 'System power', bytes: [2, 129, 0, 0] },
  { group: 'System', label: 'System sleep', bytes: [2, 130, 0, 0] },
  { group: 'System', label: 'System wake', bytes: [2, 131, 0, 0] },
  { group: 'System', label: 'Lock screen (Win+L)', bytes: [0, 0, 227, 15] },
  { group: 'System', label: 'Explorer (Win+E)', bytes: [0, 0, 227, 8] },
  { group: 'System', label: 'Task view (Win+Tab)', bytes: [0, 0, 227, 43] },
  { group: 'System', label: 'Show desktop (Win+D)', bytes: [0, 0, 227, 7] },
  { group: 'System', label: 'Zoom out (Win+-)', bytes: [0, 0, 227, 45] },
  { group: 'System', label: 'Zoom in (Win+=)', bytes: [0, 0, 227, 46] },
  { group: 'System', label: 'Switch input method (Ctrl+Space)', bytes: [0, 224, 44, 0] },
  { group: 'System', label: 'Siri (Cmd+Space hold)', bytes: [18, 0, 227, 44] },
  { group: 'Keyboard', label: 'Fn', bytes: [10, 1, 0, 0] },
  { group: 'Keyboard', label: 'Right Fn', bytes: [10, 1, 1, 0] },
  { group: 'Keyboard', label: 'Knob: toggle volume / backlight', bytes: [10, 15, 0, 0] },
  { group: 'Keyboard', label: 'Knob: toggle volume / backlight (alt 2)', bytes: [10, 13, 0, 0] },
  { group: 'Keyboard', label: 'Knob: toggle volume / backlight (alt 3)', bytes: [10, 14, 0, 0] },
  { group: 'Keyboard', label: 'Rapid fire', bytes: [11, 0, 0, 0] },
  { group: 'Profile', label: 'Next profile', bytes: [8, 0, 1, 0] },
  { group: 'Profile', label: 'Previous profile', bytes: [8, 0, 2, 0] },
  { group: 'Profile', label: 'Cycle profiles', bytes: [8, 0, 3, 0] },
  { group: 'Profile', label: 'Switch to profile 1', bytes: [8, 0, 4, 0] },
  { group: 'Profile', label: 'Switch to profile 2', bytes: [8, 0, 4, 1] },
  { group: 'Profile', label: 'Switch to profile 3', bytes: [8, 0, 4, 2] },
  { group: 'Profile', label: 'Switch to profile 4', bytes: [8, 0, 4, 3] },
  { group: 'Symbols', label: '(  (Shift+9)', bytes: [0, 0, 229, 38] },
  { group: 'Symbols', label: ')  (Shift+0)', bytes: [0, 0, 229, 39] },
  { group: 'Symbols', label: '{  (Shift+[)', bytes: [0, 225, 47, 0] },
  { group: 'Symbols', label: '}  (Shift+])', bytes: [0, 225, 48, 0] },
];

export const MOUSE_ACTIONS = [
  { label: 'Left click', bytes: [1, 0, 240, 0], code: 240 },
  { label: 'Right click', bytes: [1, 0, 241, 0], code: 241 },
  { label: 'Middle click', bytes: [1, 0, 242, 0], code: 242 },
  { label: 'Back', bytes: [1, 0, 243, 0], code: 243 },
  { label: 'Forward', bytes: [1, 0, 244, 0], code: 244 },
  { label: 'Scroll up', bytes: [1, 0, 245, 1] },
  { label: 'Scroll down', bytes: [1, 0, 245, 255] },
];

export const MODIFIERS = { none: 0, ctrl: 224, shift: 225, alt: 226, win: 227 };
export const MACRO_MODES = [
  { id: 'repeat_times', code: 0, label: 'Loop' },
  { id: 'on_off', code: 1, label: 'Toggle with the key' },
  { id: 'touch_repeat', code: 2, label: 'Press to play' },
];

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- Key action <-> 4 matrix bytes ---------------------------------------
export function encodeAction(a) {
  switch (a.type) {
    case 'key': return [0, 0, a.hid, 0];
    case 'combo': return [0, MODIFIERS[a.mod] ?? 0, a.hid, a.hid2 ?? 0];
    case 'disabled': return [0, 0, 0, 0];
    case 'function':
    case 'mouse':
    case 'raw': return a.bytes.slice(0, 4);
    case 'macro': {
      const mode = MACRO_MODES.find((m) => m.id === a.mode) ?? MACRO_MODES[0];
      return [9, mode.code, a.index, 0];
    }
    default: throw new Error('unknown action ' + a.type);
  }
}

export function decodeAction(b) {
  b = Array.from(b);
  if (eq(b, [0, 0, 0, 0])) return { type: 'disabled' };
  const fn = FUNCTION_ACTIONS.find((f) => eq(f.bytes, b));
  if (fn) return { type: 'function', bytes: b, label: fn.label };
  const ms = MOUSE_ACTIONS.find((f) => eq(f.bytes, b));
  if (ms) return { type: 'mouse', bytes: b, label: ms.label };
  if (b[0] === 0) {
    if (b[1] === 0 && b[3] === 0) return { type: 'key', hid: b[2] };
    const mod = Object.keys(MODIFIERS).find((k) => MODIFIERS[k] === b[1]);
    if (mod) return { type: 'combo', mod, hid: b[2], hid2: b[3] };
  }
  if (b[0] === 9) {
    const mode = MACRO_MODES.find((m) => m.code === b[1]) ?? MACRO_MODES[0];
    return { type: 'macro', mode: mode.id, index: b[2] };
  }
  return { type: 'raw', bytes: b };
}

export function hidName(hid) {
  return HID_NAMES[hid] ?? `0x${hid.toString(16).padStart(2, '0')}`;
}

export function describeAction(a) {
  switch (a.type) {
    case 'key': return hidName(a.hid);
    case 'combo': {
      const mod = a.mod === 'none' ? '' : a.mod[0].toUpperCase() + a.mod.slice(1) + '+';
      return mod + hidName(a.hid) + (a.hid2 ? '+' + hidName(a.hid2) : '');
    }
    case 'disabled': return 'Disabled';
    case 'function':
    case 'mouse': return a.label;
    case 'macro': return `Macro ${a.index + 1}`;
    default: return 'Built-in function';
  }
}

export function shortLabel(bytes) {
  const a = decodeAction(bytes);
  if (a.type === 'key') return SHORT_NAMES[a.hid] ?? hidName(a.hid);
  if (a.type === 'disabled') return '';
  if (a.type === 'macro') return `M${a.index + 1}`;
  if (a.type === 'function' && eq(a.bytes, [10, 1, 0, 0])) return 'Fn';
  if (a.type === 'function' && eq(a.bytes, [10, 1, 1, 0])) return 'Fn';
  return '★';
}

// ---- Macros --------------------------------------------------------------
// Event list: {type:'keyboard', action:'down'|'up', value:hid}
//             {type:'mouse_button', action, value:240..244}
//             {type:'mouse_move', dx, dy}
//             {type:'delay', value:ms}
export const MACRO_BUFFER = 256;
export const MACRO_LIMIT = 248; // "checkMacroLenthIsFull"

const setBit7 = (v, on) => (on ? v | 0x80 : v & 0x7f);

export function encodeMacro(events, repeatCount = 1) {
  const used = encodeMacroInto(events, repeatCount, MACRO_BUFFER);
  const out = new Uint8Array(MACRO_BUFFER);
  out.set(used);
  return out;
}

function encodeMacroInto(events, repeatCount, capacity) {
  const o = new Uint8Array(capacity);
  const dv = new DataView(o.buffer);
  let u = 0;
  let pending = false; // an action is waiting for its 16-bit delay field
  dv.setUint16(0, repeatCount, true);
  u += 2;
  const need = (n) => {
    if (u + n > capacity) throw new RangeError('macro too long');
  };
  for (let t = 0; t < events.length; t++) {
    const a = events[t];
    const flag = (ev) => {
      let r = 0;
      if (t + 1 < events.length) {
        const nx = events[t + 1];
        if (nx.type === 'delay' && nx.value <= 127) r = nx.value;
      }
      if (ev.type !== 'mouse_move') r = setBit7(r, ev.action === 'down');
      need(1);
      o[u++] = r;
      pending = true;
      if ((r & 0x7f) > 0) {
        pending = false;
        t++;
      }
    };
    if (a.type !== 'delay' && pending) {
      need(2);
      dv.setUint16(u, 0, true);
      u += 2;
    }
    switch (a.type) {
      case 'delay':
        if (pending) {
          need(2);
          dv.setUint16(u, a.value, true);
          u += 2;
        } else {
          need(4);
          dv.setUint16(u, 0, true);
          u += 2;
          dv.setUint16(u, a.value, true);
          u += 2;
        }
        pending = false;
        break;
      case 'keyboard':
        need(1);
        o[u++] = a.value;
        pending = true;
        flag(a);
        break;
      case 'mouse_button':
        need(1);
        o[u++] = a.value;
        flag(a);
        break;
      case 'mouse_move':
        need(1);
        o[u++] = 249;
        flag(a);
        need(2);
        dv.setInt8(u++, a.dx);
        dv.setInt8(u++, a.dy);
        break;
      default:
        break;
    }
  }
  return o.slice(0, u);
}

export function macroByteLength(events) {
  // equals the original "checkMacroLenthIsFull" accounting: bytes used incl. repeat count
  return encodeMacroInto(events, 1, 4096).length;
}

export function decodeMacro(buf) {
  buf = Uint8Array.from(buf);
  const dv = new DataView(buf.buffer);
  const events = [];
  const repeatCount = dv.getUint16(0, true);
  let a = 2;
  let n = buf.slice(a, a + 4);
  for (a += 4; a < buf.length; ) {
    if (n[0] === 249) {
      events.push({ type: 'mouse_move', dx: (n[2] << 24) >> 24, dy: (n[3] << 24) >> 24 });
      let d = 0;
      if (n[1] !== 0) d = n[1] >> 1;
      else {
        d = buf[a] | (buf[a + 1] << 8);
        a += 2;
      }
      events.push({ type: 'delay', value: d });
    } else {
      const down = (n[1] & 0x80) !== 0;
      if (n[0] >= 4 && n[0] <= 239) {
        events.push({ type: 'keyboard', action: down ? 'down' : 'up', value: n[0] });
      } else if (MOUSE_ACTIONS.some((m) => m.code === n[0])) {
        events.push({ type: 'mouse_button', action: down ? 'down' : 'up', value: n[0] });
      }
      let l;
      if ((n[1] & 0x7f) !== 0) {
        l = n[1] & 0x7f;
        a -= 2;
      } else l = n[2] | (n[3] << 8);
      events.push({ type: 'delay', value: l });
    }
    n = buf.slice(a, a + 4);
    if (n.length < 4 || (n[0] === 0 && n[1] === 0 && n[2] === 0 && n[3] === 0)) break;
    a += 4;
  }
  return {
    events: events.filter((e) => !(e.type === 'delay' && e.value === 0)),
    repeatCount,
  };
}

// ---- Colour helpers ------------------------------------------------------
export const hexToRgb = (hex) => {
  const v = parseInt(hex.replace('#', ''), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, value: v };
};
export const rgbToHex = (v) => '#' + (v & 0xffffff).toString(16).padStart(6, '0');
