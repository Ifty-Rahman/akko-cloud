// Macro library kept in the browser, like the vendor driver's local macro
// files. Macros are written to the keyboard only when a key that uses them is
// written (the keyboard slot is chosen automatically).

import { macroByteLength, MACRO_LIMIT } from './codec.js';

const LIB_KEY = 'akko-macro-library-v1';

export const MODES = [
  { id: 'repeat_times', label: 'Loop', hint: 'Plays the number of times set next to Loop.' },
  { id: 'on_off', label: 'Toggle with the key', hint: 'Press the key to start looping, press again to stop.' },
  { id: 'touch_repeat', label: 'Press to play', hint: 'Repeats while the key is held down.' },
];

const empty = () => ({ folders: [], macros: [] });

export function loadLibrary() {
  try {
    const lib = JSON.parse(localStorage.getItem(LIB_KEY) || 'null');
    if (lib && Array.isArray(lib.macros) && Array.isArray(lib.folders)) return lib;
  } catch { /* fall through */ }
  return empty();
}

export function saveLibrary(lib) {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(lib));
    return true;
  } catch {
    return false;
  }
}

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

// Name for a new item: numbered after how many items there already are
// (3 macros -> "Macro_4"), skipping numbers that are taken, so a deleted
// macro's name is never handed to the next one.
export function nextName(names, base) {
  const taken = new Set(names);
  for (let i = names.length + 1; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

export function uniqueName(names, base) {
  const taken = new Set(names);
  for (let i = 1; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

// ---- vendor rules ("uiSaveMacro" / "mergeDelay" / "getKeyCheck") ----------

// Consecutive delays are merged; a delay never exceeds 65535 ms.
export function mergeDelays(events) {
  const out = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type === 'delay' && last?.type === 'delay') last.value = Math.min(65535, last.value + e.value);
    else out.push({ ...e, ...(e.type === 'delay' ? { value: Math.min(65535, Math.max(1, Math.round(e.value))) } : {}) });
  }
  return out;
}

// Keys/buttons still held down at the end of the macro.
export function heldKeys(events) {
  const down = new Map();
  for (const e of events) {
    if (e.type !== 'keyboard' && e.type !== 'mouse_button') continue;
    const k = `${e.type}:${e.value}`;
    if (e.action === 'down') down.set(k, e);
    else down.delete(k);
  }
  return [...down.values()];
}

// Returns an error message, or null when the macro may be saved.
export function validateMacro(events) {
  if (!events.length) return 'The macro is empty. Record or add some steps first.';
  if (events[0].type === 'delay') return 'A macro must start with a key, not a delay.';
  if (heldKeys(events).length) return 'Every key that goes down must also come up. Add the missing release (▲) steps.';
  if (events.some((e) => e.type === 'keyboard' && !e.value)) return 'A key step has no key set yet.';
  return null;
}

// What gets stored: merged delays and a trailing delay (vendor default 50 ms).
export function finalizeMacro(events, trailingDelay = 50) {
  const ev = mergeDelays(events);
  if (ev.length && ev[ev.length - 1].type !== 'delay') ev.push({ type: 'delay', value: Math.max(1, trailingDelay) });
  return ev;
}

export function macroSize(events) {
  try {
    return macroByteLength(events);
  } catch {
    return Infinity;
  }
}
export const fitsKeyboard = (events) => macroSize(events) <= MACRO_LIMIT;

// ---- import / export -------------------------------------------------------

export function exportMacroJSON(m) {
  return JSON.stringify({ format: 'akko-cloud-macro/1', name: m.name, mode: m.mode, repeat: m.repeat, events: m.events }, null, 2);
}

export function parseMacroJSON(text) {
  const d = JSON.parse(text);
  const list = Array.isArray(d) ? d : [d];
  return list.map((x) => {
    if (x.format !== 'akko-cloud-macro/1' || !Array.isArray(x.events)) throw new Error('Not an Akko Cloud macro file');
    return { name: String(x.name || 'Macro'), mode: MODES.some((m) => m.id === x.mode) ? x.mode : 'repeat_times', repeat: Math.max(1, Number(x.repeat) || 1), events: x.events };
  });
}

// ---- keyboard slots (per device) -------------------------------------------
// Which keyboard macro slot holds which library macro.

const slotKey = (deviceId) => `akko-macro-slots:${deviceId}`;

export function loadSlotMap(deviceId) {
  try {
    return JSON.parse(localStorage.getItem(slotKey(deviceId)) || '{}');
  } catch {
    return {};
  }
}

export function saveSlotMap(deviceId, map) {
  try { localStorage.setItem(slotKey(deviceId), JSON.stringify(map)); } catch { /* ignore */ }
}

// Lowest slot that is neither mapped to another library macro nor referenced
// by any key we know of (vendor: first free index across all configs).
export function allocateSlot(map, macroId, usedByKeys, maxSlots) {
  if (map[macroId] !== undefined) return map[macroId];
  const taken = new Set([...Object.values(map), ...usedByKeys]);
  for (let s = 0; s < maxSlots; s++) {
    if (!taken.has(s)) {
      map[macroId] = s;
      return s;
    }
  }
  throw new Error(`All ${maxSlots} keyboard macro slots are in use. Remove a macro from a key first.`);
}

export const macroIdForSlot = (map, slot) => Object.keys(map).find((id) => map[id] === slot);
