// What to draw on a keycap for a 4-byte matrix action, plus the details shown
// in the pop-up when the full meaning does not fit on the key.

import { decodeAction, hidName, SHORT_NAMES, MACRO_MODES, MODIFIERS } from './codec.js';
import { icon } from './icons.js';

const FUNCTION_ICONS = {
  'Play / Pause': 'playPause',
  'Next track': 'next',
  'Previous track': 'prev',
  Stop: 'stop',
  Mute: 'mute',
  'Volume up': 'volUp',
  'Volume down': 'volDown',
  'Media player': 'music',
  'Brightness up': 'brightUp',
  'Brightness down': 'brightDown',
  Calculator: 'calculator',
  Mail: 'mail',
  'My computer': 'computer',
  'Browser search': 'search',
  'Browser home': 'home',
  'Browser back': 'back',
  'Browser refresh': 'refresh',
  'System power': 'power',
  'System sleep': 'sleep',
  'System wake': 'wake',
  'Lock screen (Win+L)': 'lock',
  'Explorer (Win+E)': 'folder',
  'Task view (Win+Tab)': 'windows',
  'Show desktop (Win+D)': 'desktop',
  'Zoom out (Win+-)': 'zoomOut',
  'Zoom in (Win+=)': 'zoomIn',
  'Switch input method (Ctrl+Space)': 'globe',
  'Siri (Cmd+Space hold)': 'mic',
  'Knob: toggle volume / backlight': 'knob',
  'Knob: toggle volume / backlight (alt 2)': 'knob',
  'Knob: toggle volume / backlight (alt 3)': 'knob',
  'Rapid fire': 'zap',
  'Next profile': 'layersUp',
  'Previous profile': 'layers',
  'Cycle profiles': 'layers',
};

const FUNCTION_TEXT = {
  Fn: 'Fn',
  'Right Fn': 'Fn',
  '(  (Shift+9)': '(',
  ')  (Shift+0)': ')',
  '{  (Shift+[)': '{',
  '}  (Shift+])': '}',
  'Switch to profile 1': 'P1',
  'Switch to profile 2': 'P2',
  'Switch to profile 3': 'P3',
  'Switch to profile 4': 'P4',
};

const MOUSE_ICONS = {
  'Left click': 'mouseLeft',
  'Right click': 'mouseRight',
  'Middle click': 'mouseMiddle',
  Back: 'arrowLeft',
  Forward: 'arrowRight',
  'Scroll up': 'scrollUp',
  'Scroll down': 'scrollDown',
};

const MOD_LABEL = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', win: 'Win' };
const MAX_TEXT = 6; // characters that comfortably fit on a 1u keycap

// Returns { text?, icon?, special, pop?: { title, keys?: string[], text? } }
export function keycap(bytes, { fnLayer = false } = {}) {
  const a = decodeAction(bytes);
  switch (a.type) {
    case 'disabled':
      return fnLayer
        ? { text: '', special: false }
        : { icon: 'disabled', special: true, pop: { title: 'Disabled', text: 'This key does nothing.' } };
    case 'key': {
      const full = hidName(a.hid);
      const text = SHORT_NAMES[a.hid] ?? full;
      return { text, special: false, pop: text !== full || text.length > MAX_TEXT ? { title: full } : undefined };
    }
    case 'combo': {
      const keys = [...(a.mod !== 'none' ? [MOD_LABEL[a.mod]] : []), hidName(a.hid), ...(a.hid2 ? [hidName(a.hid2)] : [])];
      return { icon: 'combo', special: true, pop: { title: 'Key combination', keys } };
    }
    case 'function': {
      if (FUNCTION_TEXT[a.label]) return { text: FUNCTION_TEXT[a.label], special: true, pop: FUNCTION_TEXT[a.label] === 'Fn' ? undefined : { title: a.label } };
      return { icon: FUNCTION_ICONS[a.label] ?? 'sparkle', special: true, pop: { title: a.label } };
    }
    case 'mouse':
      return { icon: MOUSE_ICONS[a.label] ?? 'mouse', special: true, pop: { title: `Mouse: ${a.label.toLowerCase()}` } };
    case 'macro': {
      const mode = MACRO_MODES.find((m) => m.id === a.mode);
      return { text: `M${a.index + 1}`, special: true, pop: { title: `Macro ${a.index + 1}`, text: mode?.label } };
    }
    default:
      return { icon: 'sparkle', special: true, pop: { title: 'Built-in function', text: 'A special function set by the keyboard’s firmware. It is kept unless you change it.' } };
  }
}

// Fills a keycap element (button) with the visual for `cap`.
export function renderCap(el, cap) {
  const inner = document.createElement('span');
  inner.className = 'cap';
  if (cap.icon) inner.innerHTML = icon(cap.icon);
  else inner.textContent = cap.text ?? '';
  el.append(inner);
}

export { MODIFIERS };
