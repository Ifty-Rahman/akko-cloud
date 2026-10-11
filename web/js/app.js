import {
  LAYOUT, KNOB, MAIN_LIGHT_TYPES, LOGO_LIGHT_TYPES, LIGHT_NAMES, MODELS, findModel,
} from './models.js';
import {
  HID_NAMES, CODE_TO_HID, FUNCTION_ACTIONS, MOUSE_ACTIONS, MACRO_MODES,
  encodeAction, decodeAction, describeAction, rgbToHex, hexToRgb,
} from './codec.js';
import { Keyboard, VENDOR_COLOUR_CODES } from './protocol.js';
import { WebHidTransport, DemoTransport } from './transports.js';
import { MusicFollower, ScreenFollower } from './host-effects.js';
import { KEYBINDING_SECTIONS } from './keybindings.js';
import { keycap, renderCap } from './keycap.js';
import { icon } from './icons.js';
import { AKKO_MODEL_NAMES } from './akko-names.js';
import { createMacrosView } from './macros-view.js';
import {
  MODES as MACRO_PLAY_MODES, loadSlotMap, saveSlotMap, allocateSlot, macroIdForSlot, validateMacro, finalizeMacro,
} from './macro-library.js';

// ------------------------------------------------------------------ helpers
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const slot = (m, i) => Array.from(m.slice(i * 4, i * 4 + 4));
const fmtHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(' ');

let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), error ? Math.max(6000, msg.length * 70) : 2600);
}

// Progress overlay: one short label for the whole operation, a bar and a
// percentage. `steps` is how many keyboard commands the operation needs; the
// bar follows the commands the keyboard has completed (kb.done). fn may raise
// the estimate as it learns more: fn({ steps }) -> p.steps = n.
async function busy(text, fn, steps = 0) {
  const kb = S.kb;
  const start = kb?.done ?? 0;
  const p = { steps };
  const label = text.replace(/…$/, '');
  $('#busyText').textContent = label;
  setBusyBar(steps ? 0 : null);
  $('#busy').hidden = false;
  const timer = setInterval(() => {
    if (p.steps && S.kb) setBusyBar(Math.min(99, ((S.kb.done ?? 0) - start) / p.steps * 100));
  }, 120);
  try {
    const r = await fn(p);
    if (p.steps) setBusyBar(100);
    return r;
  } catch (e) {
    console.error(e);
    logNote(`error during "${label}": ${e?.message || e}`);
    toast(e?.message || String(e), true);
    return undefined;
  } finally {
    clearInterval(timer);
    $('#busy').hidden = true;
  }
}
function setBusyBar(pct) {
  const box = $('#busy');
  box.classList.toggle('indeterminate', pct === null);
  if (pct === null) {
    $('#busyPct').textContent = '';
    return;
  }
  $('#busyBar').style.width = `${pct}%`;
  $('#busyPct').textContent = `${Math.round(pct)}%`;
}

// ------------------------------------------------------------------ state
const S = {
  kb: undefined,
  transport: undefined,
  model: undefined,
  id: undefined,
  fw: undefined,
  profile: 0,
  layer: 'base',
  orig: undefined,
  work: undefined,
  selected: undefined,
  light: undefined,
  logo: undefined,
  options: undefined,
  pic: new Uint8Array(384),
  pendingMacros: new Map(), // keyboard slot -> library macro id, written with the key map
  loaded: new Set(),
  logging: false, // the user turns recording on in the Debug tab
  logLines: [],
  music: undefined,
  screen: undefined,
};

// ------------------------------------------------------------------ theme
const savedTheme = (() => {
  try { return localStorage.getItem('akko-theme'); } catch { return null; }
})();
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('#themeBtn').addEventListener('click', () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const cur = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('akko-theme', next); } catch { /* ignore */ }
});

// ------------------------------------------------------------------ connect
function initConnect() {
  const hint = $('#webhidHint');
  if (!('hid' in navigator)) {
    hint.textContent = 'This browser has no WebHID. Use desktop Chrome, Edge, Opera or Brave. Phones and tablets are not supported.';
    $('#connectUsbBtn').disabled = true;
  } else if (!window.isSecureContext) {
    hint.textContent = 'WebHID needs a secure page. Open this site over https:// (or on localhost when developing).';
    $('#connectUsbBtn').disabled = true;
  } else {
    hint.textContent = 'Press any key on the keyboard first (it answers faster right after a key press), then pick it in the browser prompt. On Linux, install the udev rule from the project README first.';
  }
  $('#connectUsbBtn').addEventListener('click', async () => {
    try {
      const t = await WebHidTransport.request();
      if (t) await connect(t);
    } catch (e) {
      toast(e.message, true);
    }
  });
  $('#demoBtn').addEventListener('click', () => connect(new DemoTransport(MODELS[0])));
  if (WebHidTransport.supported()) {
    WebHidTransport.previouslyGranted().then((t) => {
      if (t) hint.textContent = `Previously allowed: ${t.name}. Click Connect to use it.`;
    }).catch(() => {});
  }
}

async function connect(transport) {
  await busy('Connecting', async () => {
    try {
      await transport.open();
    } catch (e) {
      if (transport.kind === 'usb' && /failed to open/i.test(e?.message || '')) {
        throw new Error(/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)
          ? 'The browser is not allowed to open the keyboard. On Linux install linux/70-akko-keyboard.rules from the GitHub repo (see the README), then unplug and replug the keyboard or receiver.'
          : 'The keyboard could not be opened. Close the Akko Cloud Driver or any other configurator using it, then try again.');
      }
      throw e;
    }
    logNote(`connecting: ${transport.name} (${transport.dongle ? '2.4 GHz receiver' : transport.kind})`);
    const kb = new Keyboard(transport, { dongle: transport.dongle, log: logPacket });
    kb.onNote = logNote;
    let busyLabel;
    // Over the receiver the keyboard stops answering when, on battery, its
    // lights-off timer runs out (the firmware turns the link off with the
    // lights: a PC75B Plus+ went offline ~1 min after the last key press with a
    // 1 min timer, and not at all while charging), or after a radio hiccup. A
    // key press brings it back. Say so for as long as it lasts.
    // A slow keyboard (power-saving state) speeds up after a key press: say so
    // while it lasts. The "not answering" message below takes precedence.
    let asleepNow = false;
    kb.onSlow = (slow) => {
      logNote(slow ? 'keyboard answering slowly' : 'keyboard answering at full speed');
      if (asleepNow) return;
      const banner = $('#asleepBanner');
      banner.replaceChildren(h('b', {}, 'Your keyboard is answering slowly. '), 'Press any key on it (Shift is fine) to wake it up and speed this up.');
      banner.hidden = !slow;
    };
    kb.onAsleep = (asleep) => {
      asleepNow = asleep;
      const el = $('#busyText');
      const banner = $('#asleepBanner');
      logNote(asleep ? 'keyboard not answering (waiting for a key press)' : 'keyboard answering again');
      if (asleep) {
        busyLabel = el.textContent;
        const msg = 'Your keyboard isn’t answering. Press any key on it to continue. (On battery it stops answering once its lights go off.)';
        el.textContent = 'Waiting for the keyboard';
        banner.replaceChildren(h('b', {}, 'Waiting for the keyboard. '), msg, h('span', { class: 'hint' }, ' If its green LED keeps blinking instead, switch it off and on.'));
        banner.hidden = false;
      } else {
        if (busyLabel) el.textContent = busyLabel;
        banner.hidden = !kb.slow;
        if (kb.slow) banner.replaceChildren(h('b', {}, 'Your keyboard is answering slowly. '), 'Press any key on it (Shift is fine) to wake it up and speed this up.');
      }
    };
    const id = await kb.getDeviceId();
    const profile = await kb.getProfile().catch(() => 0);
    Object.assign(S, {
      kb, transport, id, fw: undefined, profile, model: findModel(id), layer: 'base', selected: undefined,
      loaded: new Set(), pendingMacros: new Map(), macrosSynced: false,
    });
    kb.colourCodes = S.model.colourCodes ?? VENDOR_COLOUR_CODES;
    transport.onDisconnect(() => {
      toast('Keyboard disconnected', true);
      disconnect();
    });
    showApp();
  }, 2);
  const kb = S.kb;
  if (!kb) {
    $('#connectLogRow').hidden = !S.logLines.length; // connect failed: offer the log
    return;
  }
  // Each tab reads what it needs when it is opened (as in PR #3). Firmware and
  // battery come in the background, queued behind the key map.
  const fwKey = `akko-fw:${S.id & 0x7fffffff}`;
  try { S.fw = JSON.parse(localStorage.getItem(fwKey) ?? 'null') ?? undefined; } catch { S.fw = undefined; }
  if (S.fw === undefined) {
    S.fw = await kb.getFirmwareVersion().catch(() => undefined);
    try { if (S.fw !== undefined) localStorage.setItem(fwKey, JSON.stringify(S.fw)); } catch { /* ignore */ }
  }
  if (S.transport?.dongle) await kb.getLinkStatus().catch(() => undefined);
  if (S.kb === kb) renderDeviceStrip();
}

// Name from the model id the keyboard reports (Akko's own id → name table),
// falling back to the USB product name the keyboard announces.
function modelName() {
  const fromTable = AKKO_MODEL_NAMES[S.id & 0x7fffffff];
  if (fromTable) return fromTable;
  const usb = (S.transport?.name || '').replace(/^\s*ROYUAN\s+/i, '').trim();
  return usb || 'Akko keyboard';
}

function renderDeviceStrip() {
  const link = S.transport.kind === 'demo' ? 'Demo (simulated)' : S.transport.dongle ? '2.4 GHz receiver' : 'USB cable';
  const fw = S.fw !== undefined ? `v${(S.fw >> 8).toString(16)}.${(S.fw & 255).toString(16).padStart(2, '0')}` : '…';
  $('#deviceStrip').replaceChildren(
    h('span', {}, 'Keyboard ', h('b', {}, modelName())),
    h('span', {}, 'Firmware ', h('b', {}, fw)),
    h('span', {}, 'Connection ', h('b', {}, link)),
    ...(S.kb.battery !== undefined ? [h('span', {}, 'Battery ', h('b', {}, `${S.kb.battery}%`))] : []),
  );
}

async function disconnect() {
  $('#connectLogRow').hidden = !S.logLines.length;
  S.music?.stop();
  S.screen?.stop();
  try { await S.transport?.close(); } catch { /* ignore */ }
  S.kb = undefined;
  S.transport = undefined;
  $('#appView').hidden = true;
  $('#connectView').hidden = false;
  $('#deviceSummary').hidden = true;
}
$('#disconnectBtn').addEventListener('click', disconnect);

function showApp() {
  const m = S.model;
  $('#connectView').hidden = true;
  $('#appView').hidden = false;
  $('#deviceSummary').hidden = false;
  $('#deviceName').textContent = modelName();
  renderProfiles();
  renderDeviceStrip();
  if (S.transport.dongle) toast('Connected through the 2.4 GHz receiver. Akko officially supports customisation over the USB cable — use it if a change does not stick.');
  if (m.unknownId !== undefined) toast(`${modelName()} is not a PC75B. Akko Cloud is built for the PC75B family, so its layout and features may not match.`, true);
  selectTab('keys');
}

function renderProfiles() {
  const seg = $('#profileSeg');
  seg.replaceChildren(...Array.from({ length: S.model.profiles }, (_, i) => h('button', {
    type: 'button',
    'aria-pressed': String(i === S.profile),
    title: `Profile ${i + 1}`,
    onclick: () => switchProfile(i),
  }, String(i + 1))));
}

async function switchProfile(p) {
  if (p === S.profile || !S.kb) return;
  if (isDirty() && !confirm('Discard unsaved key changes?')) return;
  await busy('Switching profile', async () => {
    await S.kb.setProfile(p);
    S.profile = p;
    S.loaded.clear();
    S.selected = undefined;
    renderProfiles();
  }, 1);
  loadTab(currentTab());
}

// ------------------------------------------------------------------ tabs
const currentTab = () => $('#tabs [aria-selected="true"]').dataset.tab;
$$('#tabs button').forEach((b) => {
  b.insertAdjacentHTML('afterbegin', icon(b.dataset.icon, 'nav-ic'));
  b.addEventListener('click', () => selectTab(b.dataset.tab));
});
function selectTab(name) {
  $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
  if (name !== 'macros') macrosView.stop();
  if (name === 'log') renderLog(); // always show the latest packets
  if (name === 'macros') {
    macrosView.render(); // the library is local
    syncKeyboardMacros(); // reads only macros keys use that are not in the library yet
    return;
  }
  if (name === 'keys' && S.loaded.has('keys') && !S.keysLoading) {
    syncMacroModes();
    renderKeys(); // macro names may have changed on the Macros tab
    renderEditor();
  }
  loadTab(name);
}
async function loadTab(name) {
  if (!S.kb) return;
  if (S.loaded.has(name)) return;
  if (name === 'keys') {
    // non-blocking: the layout is drawn at once and filled in when the read finishes
    S.loaded.add('keys');
    try { await loadKeys(); } catch (e) { S.loaded.delete('keys'); toast(e?.message || String(e), true); }
    return;
  }
  const loaders = { keys: loadKeys, lighting: loadLighting, settings: loadSettings, keybindings: async () => renderKeybindings(), backup: async () => {}, log: async () => renderLog() };
  const [label, steps] = { lighting: ['Loading lights', 2], settings: ['Loading settings', 4] }[name] ?? ['Loading', 0];
  const ok = await busy(label, async () => {
    await loaders[name]();
    return true;
  }, steps);
  if (ok) S.loaded.add(name);
}

// ================================================================== KEYS
const layers = () => [
  { id: 'base', label: `Base layer` },
  ...Array.from({ length: S.model.fnLayers }, (_, i) => ({ id: `fn${i}`, label: `Fn layer ${i + 1}` })),
];
const isFnLayer = () => S.layer !== 'base';

function slotName(idx) {
  if (idx === KNOB.press) return 'Knob press';
  if (idx === KNOB.clockwise) return 'Knob turned right';
  if (idx === KNOB.counterClockwise) return 'Knob turned left';
  return describeAction(decodeAction(slot(S.model.matrix, idx)));
}

// ---- key map loading: draw instantly, then read the real map in the background
const layerIndex = () => (S.layer === 'base' ? S.profile : Number(S.layer.slice(2)));
// Saved copies of key maps, one per keyboard, layer and profile. Like the
// vendor app (devToInfo), a saved copy is trusted, so the key map is read from
// the keyboard only the first time or on Reload: 8 of the 16 queries of a
// load over the 2.4 GHz receiver. ("-v2": copies saved by earlier versions
// could contain misread pages, so they are dropped once.)
const MAP_CACHE = 'akko-map-v2';
const cacheKey = () => `${MAP_CACHE}:${S.id & 0x7fffffff}:${S.layer}:${layerIndex()}`;
function savedMatrix() {
  try {
    const v = localStorage.getItem(cacheKey());
    if (v && v.length === 1024) return Uint8Array.from(v.match(/../g), (x) => parseInt(x, 16));
  } catch { /* storage unavailable */ }
  return undefined;
}
function cachedMatrix() {
  return savedMatrix() ?? (isFnLayer() ? new Uint8Array(512) : Uint8Array.from(S.model.matrix));
}
// after a factory reset or a restore the saved copies no longer match the keyboard
function forgetSavedMatrices() {
  try {
    const prefix = `${MAP_CACHE}:${S.id & 0x7fffffff}:`;
    for (const k of Object.keys(localStorage)) if (k.startsWith(prefix)) localStorage.removeItem(k);
  } catch { /* ignore */ }
}
try { for (const k of Object.keys(localStorage)) if (k.startsWith('akko-matrix:')) localStorage.removeItem(k); } catch { /* ignore */ }
function storeMatrix(m) {
  try { localStorage.setItem(cacheKey(), fmtHex(m).replaceAll(' ', '')); } catch { /* ignore */ }
}

async function loadKeys() {
  const seg = $('#layerSeg');
  seg.replaceChildren(...layers().map((l) => h('button', {
    'aria-pressed': String(l.id === S.layer),
    onclick: async (ev) => {
      const btn = ev.currentTarget;
      if (S.layer === l.id) return;
      if (isDirty() && !confirm('Discard unsaved key changes?')) return;
      S.layer = l.id;
      S.selected = undefined;
      $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      await readLayer();
    },
  }, l.label)));
  await readLayer();
}

// The last known map (cached from the previous read, else the defaults) is
// shown and editable at once; the read from the keyboard runs in the
// background (~3 s over the 2.4 GHz receiver). Edits made meanwhile are kept on
// top of what the keyboard reports. Writing waits until the read confirmed
// the map, so a stale cache can never be written back.
async function readLayer({ force = false } = {}) {
  const token = (S.keysToken = (S.keysToken ?? 0) + 1);
  const saved = force ? undefined : savedMatrix();
  if (saved) {
    S.orig = Uint8Array.from(saved);
    S.work = Uint8Array.from(saved);
    S.keysVerified = true;
    S.pendingMacros.clear();
    setKeysLoading('saved');
    syncMacroModes();
    renderKeys();
    renderEditor();
    return;
  }
  const base = cachedMatrix();
  S.orig = Uint8Array.from(base);
  S.work = Uint8Array.from(base);
  S.keysVerified = false;
  setKeysLoading('loading');
  renderKeys();
  renderEditor();
  try {
    // pages matching the last known map are accepted at once; others are read
    // again until two reads agree (see readPaged)
    const m = S.layer === 'base' ? await S.kb.getKeyMatrix(S.profile, base) : await S.kb.getFnMatrix(layerIndex(), base);
    if (token !== S.keysToken) return; // a newer load replaced this one
    const merged = Uint8Array.from(m);
    let edits = 0;
    for (let i = 0; i < 128; i++) {
      if (!eqBytes(slot(S.work, i), slot(base, i))) {
        merged.set(slot(S.work, i), i * 4);
        edits++;
      }
    }
    S.orig = Uint8Array.from(m);
    S.work = merged;
    if (!edits) S.pendingMacros.clear();
    storeMatrix(m);
    S.keysVerified = true;
    setKeysLoading(null);
    syncMacroModes();
  } catch (e) {
    if (token === S.keysToken) setKeysLoading('error', e);
    throw e;
  } finally {
    if (token === S.keysToken) {
      renderKeys();
      renderEditor();
    }
  }
}

let keysProgressTimer;
function setKeysLoading(state, err) {
  clearInterval(keysProgressTimer);
  S.keysLoading = state === 'loading';
  const note = $('#keysLoading');
  note.hidden = !state;
  note.classList.toggle('err', state === 'error');
  note.classList.toggle('saved', state === 'saved');
  if (state === 'saved') {
    note.hidden = false;
    note.replaceChildren('Key map from the copy saved in this browser. Changed keys outside Akko Cloud? ',
      h('button', { type: 'button', class: 'linkish', onclick: () => { if (!isDirty() || confirm('Discard unsaved key changes and read the layer again?')) readLayer({ force: true }).catch(() => {}); } }, 'Read it from the keyboard'));
  } else if (state === 'loading') {
    const bar = h('i');
    const pct = h('span', { class: 'busy-pct' }, '0%');
    note.replaceChildren(h('b', {}, 'Loading keys'), h('span', { class: 'busy-track inline' }, bar), pct,
      h('span', { class: 'muted small' }, 'You can already pick keys and make changes.'));
    const start = S.kb?.done ?? 0;
    keysProgressTimer = setInterval(() => {
      const v = Math.min(99, (((S.kb?.done ?? 0) - start) / 8) * 100);
      bar.style.width = `${v}%`;
      pct.textContent = `${Math.round(v)}%`;
    }, 120);
  } else if (state === 'error') {
    note.replaceChildren(`Couldn’t read the key map from the keyboard${err?.message ? ` (${err.message.replace(/\.$/, '')})` : ''}. Your changes are kept; writing is paused until the map has been read.`,
      h('button', { type: 'button', class: 'ghost', onclick: () => readLayer().catch(() => {}) }, 'Retry'));
  }
  updateDirty();
}

const isDirty = () => S.orig && S.work && !eqBytes(Array.from(S.orig), Array.from(S.work));
function updateDirty() {
  const d = isDirty();
  const broken = S.writeInterrupted === `${S.layer}:${layerIndex()}`;
  $('#keysDirty').hidden = !d && !broken;
  $('#keysDirty').textContent = broken ? 'Last write did not finish — write again' : 'Unsaved changes';
  $('#keysDirty').classList.toggle('err', broken);
  $('#keysWriteBtn').disabled = !S.keysVerified || (!d && !broken);
  $('#keysWriteBtn').title = S.keysVerified ? '' : 'Available once the key map has been read from the keyboard';
}

const capFor = (idx) => keycap(slot(S.work, idx), { fnLayer: isFnLayer(), macroName: macroLabel });
function actionText(a) {
  return a.type === 'macro' ? `Macro: ${macroLabel(a.index)}` : describeAction(a);
}

function keyButton(idx, attrs, cap) {
  const changed = !eqBytes(slot(S.work, idx), slot(S.orig, idx));
  const el = h('button', {
    ...attrs,
    class: [attrs.class, changed && 'changed', S.selected === idx && 'selected', cap.special && 'special'].filter(Boolean).join(' '),
    'aria-label': `${slotName(idx)}: ${isFnLayer() && !cap.special && !cap.text ? 'built-in Fn function' : actionText(decodeAction(slot(S.work, idx)))}`,
    'data-idx': idx,
    onclick: (e) => selectKey(idx, e.currentTarget),
  });
  renderCap(el, cap);
  if (cap.pop) POPS.set(el, cap.pop);
  return el;
}

function renderKeys() {
  const kb = $('#kbKeys');
  hidePop();
  kb.replaceChildren(...LAYOUT.map((k) => keyButton(k.idx, { class: 'key', style: `--x:${k.x};--y:${k.y};--w:${k.w}` }, capFor(k.idx))));
  kb.append(keyButton(KNOB.press, { class: 'knob' }, capFor(KNOB.press)));
  const knobRow = (idx, label) => {
    const cap = capFor(idx);
    const b = keyButton(idx, { class: 'knob-action' }, cap);
    b.querySelector('.cap')?.remove(); // text only: what the knob does is spelled out
    b.prepend(h('span', { class: 'knob-what' }, label));
    b.append(h('span', { class: 'knob-desc' }, isFnLayer() && !cap.special && !cap.text ? 'Built-in' : actionText(decodeAction(slot(S.work, idx)))));
    return b;
  };
  $('#knobPanel').replaceChildren(
    h('span', { class: 'knob-title' }, 'Knob'),
    knobRow(KNOB.counterClockwise, 'Turn left'),
    knobRow(KNOB.clockwise, 'Turn right'),
    knobRow(KNOB.press, 'Press'),
  );
  updateDirty();
}

// ---- pop-up with the full meaning of a keycap
const POPS = new WeakMap();
function showPop(el) {
  const pop = POPS.get(el);
  const box = $('#keyPop');
  if (!pop) return hidePop();
  box.replaceChildren(
    h('div', { class: 'pop-title' }, pop.title),
    ...(pop.keys ? [h('div', { class: 'pop-keys' }, pop.keys.flatMap((k, i) => (i ? [h('span', { class: 'plus' }, '+'), h('kbd', {}, k)] : [h('kbd', {}, k)])))] : []),
    ...(pop.text ? [h('div', { class: 'pop-text' }, pop.text)] : []),
  );
  box.hidden = false;
  const r = el.getBoundingClientRect();
  const bw = box.offsetWidth;
  const bh = box.offsetHeight;
  const left = Math.min(window.innerWidth - bw - 8, Math.max(8, r.left + r.width / 2 - bw / 2));
  const above = r.top - bh - 8;
  box.style.left = `${left + window.scrollX}px`;
  box.style.top = `${(above > 8 ? above : r.bottom + 8) + window.scrollY}px`;
}
function hidePop() {
  const box = $('#keyPop');
  if (box) box.hidden = true;
}
for (const id of ['#kbKeys', '#knobPanel']) {
  const root = $(id);
  root.addEventListener('pointerover', (e) => { const el = e.target.closest('button'); if (el && root.contains(el)) showPop(el); });
  root.addEventListener('pointerleave', hidePop);
  root.addEventListener('focusin', (e) => showPop(e.target.closest('button')));
  root.addEventListener('focusout', hidePop);
}
window.addEventListener('scroll', hidePop, { passive: true });
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest?.('#kbKeys, #knobPanel')) hidePop();
});

function selectKey(idx, fromEl) {
  const inPanel = fromEl?.closest?.('#knobPanel');
  S.selected = idx;
  renderKeys();
  renderEditor();
  // touch screens have no hover: show the pop-up for the tapped key instead
  const el = $(`${inPanel ? '#knobPanel' : '#kbKeys'} [data-idx="${idx}"]`);
  if (el) showPop(el);
}

const hidOptions = (selected) => {
  const groups = [
    ['Letters', range(4, 29)], ['Numbers', range(30, 39)], ['Editing & navigation', [40, 41, 42, 43, 44, 57, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 101]],
    ['Symbols', [45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56, 50, 100]], ['Function keys', [...range(58, 69), ...range(104, 115)]],
    ['Modifiers', range(224, 231)], ['Keypad', [83, ...range(84, 99), 103]], ['International', [135, 136, 137, 138, 139, 144, 145]],
  ];
  return groups.map(([g, codes]) => h('optgroup', { label: g }, codes.map((c) => h('option', { value: c, selected: c === selected }, HID_NAMES[c] ?? c))));
};
function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function captureButton(onHid) {
  const btn = h('button', { class: 'capture', type: 'button' }, 'Press a key…');
  btn.addEventListener('click', () => {
    btn.classList.add('listening');
    btn.textContent = 'Listening — press a key';
    const handler = (e) => {
      e.preventDefault();
      const hid = CODE_TO_HID[e.code];
      window.removeEventListener('keydown', handler, true);
      btn.classList.remove('listening');
      btn.textContent = 'Press a key…';
      if (hid) onHid(hid);
      else toast(`Unsupported key ${e.code}`, true);
    };
    window.addEventListener('keydown', handler, true);
  });
  return btn;
}

function renderEditor() {
  const ed = $('#keyEditor');
  if (S.selected === undefined) {
    ed.replaceChildren(h('p', { class: 'muted' }, 'Select a key above to remap it.'));
    return;
  }
  const idx = S.selected;
  const cur = decodeAction(slot(S.work, idx));
  const fnDefault = isFnLayer() && cur.type === 'disabled';
  const kinds = [
    ['key', 'Single key'], ['combo', 'Key combination'], ['function', 'Media & system'], ['mouse', 'Mouse'],
    ['macro', 'Macro'], ['disabled', isFnLayer() ? 'Built-in Fn function' : 'Disabled'],
    // unknown firmware functions can be kept, but not typed in by hand
    ...(cur.type === 'raw' ? [['raw', 'Keep built-in function']] : []),
  ];
  const typeSel = h('select', {}, kinds.map(([v, l]) => h('option', { value: v, selected: v === cur.type }, l)));
  const body = h('div', { class: 'grid' });
  let read = () => ({ type: 'disabled' });

  const typeField = h('label', { class: 'field' }, h('span', {}, 'Action type'), typeSel);
  function build() {
    const t = typeSel.value;
    body.replaceChildren(typeField); // same row as the action's own fields
    if (t === 'key') {
      const sel = h('select', {}, hidOptions(cur.type === 'key' ? cur.hid : 4));
      body.append(h('label', { class: 'field' }, h('span', {}, 'Key'), sel), h('div', { class: 'field' }, h('span', {}, 'or'), captureButton((hid) => (sel.value = hid))));
      read = () => ({ type: 'key', hid: Number(sel.value) });
    } else if (t === 'combo') {
      const mod = h('select', {}, ['ctrl', 'shift', 'alt', 'win', 'none'].map((m) => h('option', { value: m, selected: cur.mod === m }, m === 'none' ? '(none)' : m[0].toUpperCase() + m.slice(1))));
      const k1 = h('select', {}, hidOptions(cur.type === 'combo' ? cur.hid : 6));
      const k2 = h('select', {}, h('option', { value: 0 }, '(none)'), hidOptions(cur.type === 'combo' ? cur.hid2 : -1));
      body.append(h('label', { class: 'field' }, h('span', {}, 'Modifier'), mod), h('label', { class: 'field' }, h('span', {}, 'Key'), k1), h('label', { class: 'field' }, h('span', {}, 'Second key (optional)'), k2));
      read = () => ({ type: 'combo', mod: mod.value, hid: Number(k1.value), hid2: Number(k2.value) });
    } else if (t === 'function') {
      const groups = [...new Set(FUNCTION_ACTIONS.map((f) => f.group))];
      const sel = h('select', {}, groups.map((g) => h('optgroup', { label: g }, FUNCTION_ACTIONS.map((f, i) => (f.group === g ? h('option', { value: i, selected: cur.label === f.label }, f.label) : null)))));
      body.append(h('label', { class: 'field' }, h('span', {}, 'Action'), sel));
      read = () => ({ type: 'function', bytes: FUNCTION_ACTIONS[Number(sel.value)].bytes });
    } else if (t === 'mouse') {
      const sel = h('select', {}, MOUSE_ACTIONS.map((m, i) => h('option', { value: i, selected: cur.label === m.label }, m.label)));
      body.append(h('label', { class: 'field' }, h('span', {}, 'Mouse action'), sel));
      read = () => ({ type: 'mouse', bytes: MOUSE_ACTIONS[Number(sel.value)].bytes });
    } else if (t === 'macro') {
      const lib = [...macrosView.library().macros].sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
      const curSlot = cur.type === 'macro' ? cur.index : undefined;
      const curId = curSlot !== undefined ? macroIdOnSlot(curSlot) : undefined;
      const onKeyboardOnly = curSlot !== undefined && !libMacro(curId);
      if (!lib.length && !onKeyboardOnly) {
        body.append(h('div', { class: 'field' }, h('p', { class: 'muted', style: 'margin:0' }, 'You have no macros yet. Record one on the Macros tab, then come back to assign it.'),
          h('div', {}, h('button', { type: 'button', onclick: () => selectTab('macros') }, 'Open Macros'))));
        read = () => { throw new Error('Create a macro on the Macros tab first.'); };
        return;
      }
      const sel = h('select', {},
        onKeyboardOnly ? h('option', { value: `slot:${curSlot}`, selected: true }, macroLabel(curSlot)) : null,
        lib.map((m) => h('option', { value: `lib:${m.id}`, selected: m.id === curId }, m.name)));
      const md = h('select', {}, MACRO_MODES.map((m) => h('option', { value: m.id, selected: cur.mode === m.id }, m.label)));
      const mdField = h('label', { class: 'field' }, h('span', {}, 'Playback'), md);
      const info = h('div', { class: 'field macro-pick-info' });
      const update = () => {
        const v = sel.value;
        mdField.hidden = !v.startsWith('slot:');
        if (v.startsWith('slot:')) {
          info.replaceChildren(h('p', { class: 'muted small', style: 'margin:0' }, 'This macro is on the keyboard but not in your library.'),
            h('div', {}, h('button', { type: 'button', onclick: () => copyMacroToLibrary(curSlot, md.value) }, 'Copy it into the library to edit it')));
          return;
        }
        const m = libMacro(v.slice(4));
        const mode = MACRO_PLAY_MODES.find((x) => x.id === m.mode);
        const err = validateMacro(m.events);
        info.replaceChildren(h('p', { class: `small ${err ? 'err' : 'muted'}`, style: 'margin:0' },
          err ? `Not ready: ${err}` : `Plays: ${mode.label.toLowerCase()}${m.mode === 'repeat_times' ? ` ×${m.repeat}` : ''} — ${mode.hint}`),
          h('p', { class: 'muted small', style: 'margin:0' }, 'Change the steps or how it plays on the ', h('a', { href: '#', 'data-goto': 'macros', onclick: (e) => e.preventDefault() }, 'Macros tab'), '.'));
      };
      sel.addEventListener('change', update);
      update();
      body.append(h('label', { class: 'field' }, h('span', {}, 'Macro'), sel), mdField, info);
      read = () => {
        const v = sel.value;
        if (v.startsWith('slot:')) return { type: 'macro', index: Number(v.slice(5)), mode: md.value };
        const m = libMacro(v.slice(4));
        const err = validateMacro(m.events);
        if (err) throw new Error(`“${m.name}” can’t be used yet: ${err}`);
        return { type: 'macro', index: slotForMacro(m), mode: m.mode };
      };
    } else if (t === 'disabled') {
      body.append(h('p', { class: 'muted' }, isFnLayer() ? 'The key keeps the keyboard’s built-in Fn behaviour (see the Shortcuts tab).' : 'The key will do nothing.'));
      read = () => ({ type: 'disabled' });
    } else {
      const bytes = slot(S.work, idx);
      body.append(h('p', { class: 'muted' }, 'This key has a special function set by the keyboard’s firmware. It stays as it is.'));
      read = () => ({ type: 'raw', bytes });
    }
  }
  typeSel.addEventListener('change', build);
  build();

  const apply = () => {
    try {
      const bytes = encodeAction(read());
      S.work.set(bytes, idx * 4);
      renderKeys();
      renderEditor();
    } catch (e) {
      toast(e.message, true);
    }
  };
  const restore = () => {
    const def = isFnLayer() ? [0, 0, 0, 0] : slot(S.model.matrix, idx);
    S.work.set(def, idx * 4);
    renderKeys();
    renderEditor();
  };
  ed.replaceChildren(
    h('div', { class: 'editor-head' }, h('h2', {}, slotName(idx)),
      h('span', { class: 'now' }, 'currently: ', h('b', {}, fnDefault ? 'built-in Fn function' : actionText(cur)))),
    body,
    h('div', { class: 'editor-actions' },
      h('button', { class: 'primary', onclick: apply }, 'Apply to key'),
      h('button', { class: 'ghost', onclick: restore }, isFnLayer() ? 'Clear' : 'Restore default'),
      h('span', { class: 'muted small' }, 'Changes are staged until you press “Write to keyboard”.')),
  );
}

$('#keysWriteBtn').addEventListener('click', () => busy('Setting keys', async (p) => {
  // Like the vendor app (setKeyConfig), every library macro this layer's keys
  // use is written before the key map, not just newly assigned ones, so the
  // keyboard's copy always matches the library. Macros that exist only on the
  // keyboard (not in the library) are left as they are.
  const used = new Set();
  for (let i = 0; i < 128; i++) if (S.work[i * 4] === 9) used.add(S.work[i * 4 + 2]);
  const toWrite = [...used].sort((a, b) => a - b).filter((x) => libMacro(macroIdOnSlot(x)));
  p.steps = toWrite.length * 9 + 17; // macro: 5 pages + 4 read back; key map: 9 + 8 read back
  for (const s of toWrite) {
    const id = macroIdOnSlot(s);
    const m = libMacro(id);
    if (!m) continue;
    await writeMacroToKeyboard(m, s);
    const map = slotMap();
    for (const k of Object.keys(map)) if (map[k] === s && k !== id) delete map[k];
    map[id] = s;
    saveSlotMap(deviceKey(), map);
    S.pendingMacros.delete(s);
  }
  const target = `${S.layer}:${layerIndex()}`;
  try {
    if (S.layer === 'base') await S.kb.setKeyMatrixVerified(S.work, S.profile);
    else await S.kb.setFnMatrixVerified(S.work, layerIndex());
  } catch (e) {
    S.writeInterrupted = target; // the keyboard may hold a partial map: keep Write enabled
    updateDirty();
    throw e;
  }
  if (S.writeInterrupted === target) S.writeInterrupted = undefined;
  S.orig = Uint8Array.from(S.work);
  storeMatrix(S.work);
  renderKeys();
  toast('Key map saved to keyboard');
}));
$('#keysReloadBtn').addEventListener('click', () => {
  if (isDirty() && !confirm('Discard unsaved key changes and read the layer again?')) return;
  readLayer({ force: true }).catch(() => {});
});
$('#keysDefaultsBtn').addEventListener('click', () => {
  S.work = isFnLayer() ? new Uint8Array(512) : Uint8Array.from(S.model.matrix);
  renderKeys();
  renderEditor();
  toast('Defaults staged — press “Write to keyboard” to apply');
});

// ================================================================== LIGHTING
async function loadLighting() {
  S.light = await S.kb.getLight();
  S.logo = S.model.logo ? await S.kb.getLogoLight().catch(() => undefined) : undefined;
  // The per-key colours (7 reads over the receiver) are only read when the
  // keyboard is showing them; otherwise the painter starts blank. "Load from
  // keyboard" reads them on request.
  S.pic = S.light?.type === 'LightUserPicture' ? await S.kb.getUserPicture() : new Uint8Array(384);
  renderLightCard($('#mainLightCard'), 'Key backlight', MAIN_LIGHT_TYPES, S.light, async (l) => {
    await S.kb.setLight(l);
    S.light = l;
    updateHostCard();
  });
  if (S.model.logo) {
    renderLightCard($('#logoLightCard'), 'LED Strip', LOGO_LIGHT_TYPES, S.logo ?? { type: 'LightOff' }, async (l) => {
      await S.kb.setLogoLight(l);
      S.logo = l;
    });
  } else {
    $('#logoLightCard').replaceChildren(h('h2', {}, 'LED Strip'), h('p', { class: 'muted' }, 'This model has no LED strip.'));
  }
  renderPaint();
  updateHostCard();
}


const OPTION_LABELS = {
  z: 'Zig-zag', return: 'Return', down: 'Downward', up: 'Upward', out: 'Outward', in: 'Inward',
  'anti-clockwise': 'Anti-clockwise', clockwise: 'Clockwise', right: 'Right', left: 'Left',
  upright: 'Upright', separate: 'Separate', intersect: 'Intersect',
};

function renderLightCard(card, title, types, state, onApply) {
  const typeSel = h('select', {}, types.map((t) => h('option', { value: t.type, selected: t.type === state.type }, LIGHT_NAMES[t.type] ?? t.type)));
  const area = h('div', { class: 'form' });
  const draft = { ...state };

  function build() {
    const def = types.find((t) => t.type === typeSel.value) ?? types[0];
    draft.type = def.type;
    area.replaceChildren();
    if (def.type === 'LightOff') {
      area.append(h('p', { class: 'muted' }, 'Lighting off.'));
      return;
    }
    if (def.type === 'LightUserPicture') area.append(h('p', { class: 'muted small' }, 'Shows the custom per-key colours painted below.'));
    if (!def.noValue) {
      const v = h('input', { type: 'range', min: 0, max: 4, step: 1, value: draft.value ?? 4, oninput: (e) => (draft.value = Number(e.target.value)) });
      area.append(h('label', { class: 'field' }, h('span', {}, 'Brightness'), v));
      draft.value = draft.value ?? 4;
    }
    if (def.speed) {
      const v = h('input', { type: 'range', min: 0, max: 4, step: 1, value: draft.speed ?? 2, oninput: (e) => (draft.speed = Number(e.target.value)) });
      area.append(h('label', { class: 'field' }, h('span', {}, 'Speed'), v));
      draft.speed = draft.speed ?? 2;
    } else delete draft.speed;
    if (def.options) {
      if (!def.options.includes(draft.option)) draft.option = def.options[0];
      const o = h('select', { onchange: (e) => (draft.option = e.target.value) }, def.options.map((x) => h('option', { value: x, selected: x === draft.option }, OPTION_LABELS[x] ?? x)));
      area.append(h('label', { class: 'field' }, h('span', {}, 'Direction / style'), o));
    } else delete draft.option;
    if (def.rgb) {
      draft.rgb = draft.rgb ?? 0xff0000;
      // One colour box: shows the rainbow when rainbow mode is on, otherwise the
      // chosen colour. Clicking it opens the colour picker.
      const RAINBOW = 'conic-gradient(from 90deg, #ff3b3b, #ffb13b, #f5ff3b, #3bff6a, #3bd8ff, #4b5bff, #d53bff, #ff3b3b)';
      const box = h('label', { class: 'colour-box', title: 'Choose colour' });
      const picker = h('input', { type: 'color', value: rgbToHex(draft.rgb), 'aria-label': 'Choose colour' });
      const rainbowInput = h('input', { type: 'checkbox', checked: !!draft.dazzle });
      const paint = () => {
        box.style.background = draft.dazzle ? RAINBOW : rgbToHex(draft.rgb);
        box.classList.toggle('is-rainbow', !!draft.dazzle);
      };
      picker.addEventListener('input', (e) => {
        draft.rgb = hexToRgb(e.target.value).value;
        draft.dazzle = false;
        rainbowInput.checked = false;
        paint();
      });
      rainbowInput.addEventListener('change', () => {
        draft.dazzle = rainbowInput.checked;
        paint();
      });
      box.append(picker);
      paint();
      area.append(h('div', { class: 'field' }, h('span', {}, 'Colour'),
        h('div', { class: 'inline' }, box, h('label', { class: 'switch' }, rainbowInput, h('span', {}, 'Rainbow colours')))));
    } else {
      delete draft.rgb;
      delete draft.dazzle;
    }
    if (def.host) area.append(h('p', { class: 'muted small' }, def.host === 'music'
      ? 'Driven by audio from this browser. After applying, start streaming in the panel below and keep this page open.'
      : 'Mirrors the average colour of a shared screen. After applying, start streaming below and keep this page open.'));
  }
  typeSel.addEventListener('change', build);
  build();
  card.replaceChildren(
    h('div', { class: 'card-head' }, h('h2', {}, title)),
    h('div', { class: 'form' }, h('label', { class: 'field' }, h('span', {}, 'Effect'), typeSel), area,
      h('div', {}, h('button', { class: 'primary', onclick: () => busy('Setting lights', async () => { await onApply({ ...draft }); toast(`${title} updated`); }, 1) }, 'Apply'))),
  );
}

function updateHostCard() {
  const card = $('#hostEffectCard');
  const def = MAIN_LIGHT_TYPES.find((t) => t.type === S.light?.type);
  if (!def?.host) {
    card.hidden = true;
    S.music?.stop();
    S.screen?.stop();
    return;
  }
  card.hidden = false;
  if (def.host === 'music') {
    const meter = h('div', { class: 'meter' }, Array.from({ length: 32 }, () => h('i')));
    const status = h('span', { class: 'muted' }, S.music?.running ? 'Streaming' : 'Stopped');
    const start = async (src) => {
      try {
        S.screen?.stop();
        S.music = new MusicFollower(S.kb, (lv) => lv.forEach((v, i) => (meter.children[i].style.height = `${(v / 6) * 100}%`)));
        await S.music.start(src);
        status.textContent = 'Streaming';
      } catch (e) {
        toast(e.message, true);
      }
    };
    card.replaceChildren(h('div', { class: 'card-head' }, h('h2', {}, 'Music rhythm source'), h('span', { class: 'spacer' }), status),
      h('p', { class: 'muted' }, 'Share a browser tab or screen with audio (tick “Share audio”), or use a microphone.'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => start('display') }, 'Share tab / system audio'),
        h('button', { onclick: () => start('mic') }, 'Use microphone'),
        h('button', { class: 'ghost', onclick: () => { S.music?.stop(); status.textContent = 'Stopped'; } }, 'Stop')),
      h('div', { style: 'height:12px' }), meter);
  } else {
    const sw = h('div', { class: 'swatch' });
    const status = h('span', { class: 'muted' }, S.screen?.running ? 'Streaming' : 'Stopped');
    card.replaceChildren(h('div', { class: 'card-head' }, h('h2', {}, 'Screen colour source'), h('span', { class: 'spacer' }), status),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => {
          try {
            S.music?.stop();
            S.screen = new ScreenFollower(S.kb, (r, g, b) => (sw.style.background = `rgb(${r},${g},${b})`));
            await S.screen.start();
            status.textContent = 'Streaming';
          } catch (e) { toast(e.message, true); }
        } }, 'Share screen'),
        h('button', { class: 'ghost', onclick: () => { S.screen?.stop(); status.textContent = 'Stopped'; } }, 'Stop'), sw));
  }
}

// per-key painter
let painting = false;
function renderPaint() {
  const kb = $('#kbPaint');
  kb.replaceChildren();
  for (const k of LAYOUT) {
    const i = k.idx * 3;
    const c = `rgb(${S.pic[i]},${S.pic[i + 1]},${S.pic[i + 2]})`;
    const el = h('button', {
      class: 'key', style: `--x:${k.x};--y:${k.y};--w:${k.w};--c:${c}`, title: slotName(k.idx), 'data-idx': k.idx,
    }, h('span', {}, '·'));
    kb.append(el);
  }
}
function paintAt(target) {
  const el = target?.closest?.('.key');
  if (!el || !el.dataset.idx) return;
  const { r, g, b } = hexToRgb($('#brushColor').value);
  const i = Number(el.dataset.idx) * 3;
  S.pic.set([r, g, b], i);
  el.style.setProperty('--c', `rgb(${r},${g},${b})`);
}
$('#kbPaint').addEventListener('pointerdown', (e) => { painting = true; paintAt(e.target); });
$('#kbPaint').addEventListener('pointermove', (e) => { if (painting) paintAt(document.elementFromPoint(e.clientX, e.clientY)); });
window.addEventListener('pointerup', () => (painting = false));
$('#brushColor').addEventListener('input', (e) => ($('#brushBox').style.background = e.target.value));
$('#picFillBtn').addEventListener('click', () => {
  const { r, g, b } = hexToRgb($('#brushColor').value);
  for (const k of LAYOUT) S.pic.set([r, g, b], k.idx * 3);
  renderPaint();
});
$('#picClearBtn').addEventListener('click', () => { S.pic.fill(0); renderPaint(); });
$('#picLoadBtn').addEventListener('click', () => busy('Loading colours', async () => { S.pic = await S.kb.getUserPicture(); renderPaint(); }, 7));
$('#picWriteBtn').addEventListener('click', () => busy('Setting colours', async () => {
  await S.kb.setUserPicture(S.pic);
  const l = { type: 'LightUserPicture', value: S.light?.value ?? 4 };
  await S.kb.setLight(l);
  S.light = l;
  renderLightCard($('#mainLightCard'), 'Backlight', MAIN_LIGHT_TYPES, S.light, async (x) => { await S.kb.setLight(x); S.light = x; updateHostCard(); });
  updateHostCard();
  toast('Custom colours active');
}, 8));

// ================================================================== MACROS
// Macros live in a library in this browser, like the vendor driver's local
// macro files. A macro goes onto the keyboard when a key that uses it is
// written; the keyboard slot is picked automatically (see macro-library.js).
const deviceKey = () => S.id & 0x7fffffff;
const slotMap = () => loadSlotMap(deviceKey());

async function writeMacroToKeyboard(m, slotIndex) {
  const err = validateMacro(m.events);
  if (err) throw new Error(`“${m.name}”: ${err}`);
  await S.kb.setMacroVerified(slotIndex, finalizeMacro(m.events), m.mode === 'repeat_times' ? Math.max(1, m.repeat || 1) : 1);
}

// Once per connection, when the Macros tab is opened: macros that keys use but
// that are not in this browser's library are read from the keyboard.
async function syncKeyboardMacros() {
  if (!S.kb || S.macrosSynced) return;
  S.macrosSynced = true;
  const ok = await busy('Loading macros', async (p) => {
    const found = await macrosView.syncFromKeyboard(slotsUsedByKeys(), (i, n) => (p.steps = n * 2));
    if (found) toast(`Added ${found} macro${found === 1 ? '' : 's'} from the keyboard to your library`);
    return true;
  });
  if (!ok) S.macrosSynced = false; // try again next time the tab is opened
  if (currentTab() === 'macros') macrosView.render();
}

// Play mode of a keyboard slot, from a key that uses it in the current layer.
function modeForSlot(s) {
  for (let i = 0; S.work && i < 128; i++) {
    if (S.work[i * 4] === 9 && S.work[i * 4 + 2] === s) return MACRO_MODES.find((m) => m.code === S.work[i * 4 + 1])?.id;
  }
  return undefined;
}

const macrosView = createMacrosView({ h, $, toast, busy, S, writeMacroToKeyboard, modeForSlot, slotInUse: (s) => slotsUsedByKeys().has(s) });

const libMacro = (id) => macrosView.library().macros.find((m) => m.id === id);
const pendingIdForSlot = (s) => S.pendingMacros.get(s);
function macroIdOnSlot(s) {
  return pendingIdForSlot(s) ?? macroIdForSlot(slotMap(), s);
}
function macroLabel(s) {
  return libMacro(macroIdOnSlot(s))?.name ?? `Macro #${s + 1} (on the keyboard)`;
}

// Keyboard slots used by any key we know of: this layer's working copy plus
// the cached key maps of every profile and Fn layer.
function slotsUsedByKeys() {
  const used = new Set();
  const scan = (m) => { for (let i = 0; i < 128; i++) if (m[i * 4] === 9) used.add(m[i * 4 + 2]); };
  if (S.work) scan(S.work);
  try {
    const prefix = `${MAP_CACHE}:${deviceKey()}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = k?.startsWith(prefix) ? localStorage.getItem(k) : null;
      if (v?.length === 1024) scan(Uint8Array.from(v.match(/../g), (x) => parseInt(x, 16)));
    }
  } catch { /* storage unavailable */ }
  return used;
}

// Picks (or reuses) the keyboard slot for a library macro assigned to a key.
function slotForMacro(m) {
  for (const [s, id] of S.pendingMacros) if (id === m.id) return s;
  const map = slotMap();
  for (const [s, id] of S.pendingMacros) map[id] = s;
  const s = allocateSlot(map, m.id, slotsUsedByKeys(), S.model.maxMacros);
  S.pendingMacros.set(s, m.id); // (re)written with the key map
  return s;
}

// The play mode is part of the key's action bytes. When a macro's mode was
// changed on the Macros tab, stage the new mode on keys that use it.
function syncMacroModes() {
  if (!S.work || S.keysLoading) return false;
  let changed = 0;
  for (let i = 0; i < 128; i++) {
    if (S.work[i * 4] !== 9) continue;
    const m = libMacro(macroIdOnSlot(S.work[i * 4 + 2]));
    const code = m && MACRO_MODES.find((x) => x.id === m.mode)?.code;
    if (code !== undefined && S.work[i * 4 + 1] !== code) {
      S.work[i * 4 + 1] = code;
      changed++;
    }
  }
  if (changed) toast(`Play mode updated on ${changed} macro key${changed === 1 ? '' : 's'} — press “Write to keyboard” to save it`);
  return changed > 0;
}

// Reads a macro that is on the keyboard but not in the library, and adds it.
async function copyMacroToLibrary(s, mode) {
  await busy('Loading macro', async () => {
    const got = await S.kb.getMacro(s);
    if (!got.events.length) throw new Error('That keyboard slot is empty.');
    const item = macrosView.adopt({ name: `Keyboard macro ${s + 1}`, mode, repeat: Math.max(1, got.repeatCount || 1), events: got.events });
    const map = slotMap();
    for (const k of Object.keys(map)) if (map[k] === s) delete map[k];
    map[item.id] = s;
    saveSlotMap(deviceKey(), map);
    toast(`Added “${item.name}” to your macro library`);
    renderKeys();
    renderEditor();
  }, 2);
}

// ================================================================== SETTINGS
async function loadSettings() {
  const [rate, opt, deb, sl] = [await S.kb.getReportRate(), await S.kb.getKeyboardOption(), await S.kb.getDebounce(), await S.kb.getSleepTime()];
  S.options = opt;
  const m = S.model;
  const grid = $('#settingsGrid');

  const rateSel = h('select', {}, m.reportRates.map((r) => h('option', { value: r, selected: r === rate }, `${r} Hz`)));
  const debVal = h('b', {}, deb);
  const debIn = h('input', { type: 'range', min: m.debounce.min, max: m.debounce.max, value: Math.min(m.debounce.max, Math.max(m.debounce.min, deb || 1)), oninput: (e) => (debVal.textContent = e.target.value) });
  const perf = h('div', { class: 'card' }, h('h2', {}, 'Performance'), h('div', { class: 'form' },
    h('label', { class: 'field' }, h('span', {}, 'Polling rate (this profile)'),
      h('div', { class: 'inline-apply' }, rateSel, h('button', { onclick: () => busy('Setting polling rate', async () => { await S.kb.setReportRate(Number(rateSel.value)); toast('Polling rate saved'); }, 1) }, 'Apply'))),
    h('label', { class: 'field' }, h('span', {}, 'Debounce: ', debVal, h('span', { class: 'muted' }, ' (1 = fastest, 10 = most stable)')),
      h('div', { class: 'inline-apply' }, debIn, h('button', { onclick: () => busy('Setting debounce', async () => { await S.kb.setDebounce(Number(debIn.value)); toast('Debounce saved'); }, 1) }, 'Apply')))));

  const sleepRow = (label, hint, secs, min, max) => {
    const never = h('input', { type: 'checkbox', checked: secs === 0 });
    const val = h('input', { type: 'number', min, max, value: secs === 0 ? max : Math.round(secs / 60), disabled: secs === 0, 'aria-label': `${label} (minutes)` });
    never.addEventListener('change', () => (val.disabled = never.checked));
    return {
      el: h('div', { class: 'sleep-row' }, h('span', { class: 'name' }, label, h('span', { class: 'hint' }, hint)), h('span', { class: 'num' }, val, 'min'),
        h('label', { class: 'switch' }, never, h('span', {}, 'Never'))),
      get: () => (never.checked ? 0 : Math.max(min, Math.min(max, Number(val.value) || min)) * 60),
    };
  };
  // Same two timers as the vendor app: "Light off" (sleepTime.time_24) and
  // "Sleep" (sleepTime.deepTime_24), and the Bluetooth pair.
  const LIGHTS = 'Only the lights go out';
  const SLEEP = 'The keyboard goes to sleep';
  const rows = {
    rf: sleepRow('Lights off after', LIGHTS, sl.rf, m.sleep.min, m.sleep.max),
    deepRf: sleepRow('Sleep after', SLEEP, sl.deepRf, m.sleep.minDeep, m.sleep.maxDeep),
    bt: sleepRow('Lights off after', LIGHTS, sl.bt, m.sleep.min, m.sleep.max),
    deepBt: sleepRow('Sleep after', SLEEP, sl.deepBt, m.sleep.minDeep, m.sleep.maxDeep),
  };
  const sleepCard = h('div', { class: 'card' }, h('h2', {}, 'Wireless power saving'),
    h('p', { class: 'muted small' }, 'Both timers count from your last key press, and any key brings the keyboard back. On battery, once the lights go off the keyboard also stops answering this app over the 2.4 GHz receiver until you press a key. While it charges, the lights stay on.'),
    h('div', { class: 'sleep-group' }, h('h3', {}, '2.4 GHz receiver'), rows.rf.el, rows.deepRf.el),
    h('div', { class: 'sleep-group' }, h('h3', {}, 'Bluetooth'), rows.bt.el, rows.deepBt.el),
    h('div', { class: 'card-actions' }, h('button', { class: 'primary', onclick: () => busy('Setting power saving', async () => {
      const next = Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.get()]));
      await S.kb.setSleepTime(next);
      toast('Power saving saved');
    }, 1) }, 'Apply')));

  // Only the switches the PC75B manual documents (Fn + Win, Fn + W). Every
  // other option bit is preserved unchanged on write: the original driver does
  // not expose them and their meaning on this keyboard is not confirmed.
  const toggles = [
    ['winKeyLock', 'Lock Windows key', 'Same as Fn + Left Win on the keyboard.'],
    ['wasdArrowSwap', 'Swap WASD and arrow keys', 'Same as Fn + W on the keyboard.'],
  ];
  const mk = ([k, label, desc]) => h('label', { class: 'switch' }, h('span', {}, label, desc ? h('span', { class: 'desc' }, desc) : null),
    h('input', { type: 'checkbox', checked: !!S.options[k], onchange: (e) => busy('Setting option', async () => {
      const next = { ...S.options, [k]: e.target.checked };
      await S.kb.setKeyboardOption(next);
      S.options = next;
      toast('Saved');
    }, 2) }));
  const optCard = h('div', { class: 'card' }, h('h2', {}, 'Keyboard options (this profile)'), h('div', { class: 'opt-list' }, toggles.map(mk)),
    h('p', { class: 'muted small', style: 'margin-top:12px' }, `OS mode: ${S.options.macMode ? 'Mac' : 'Windows'}. Set it with the switch on the back of the keyboard (left = Windows, right = Mac).`));

  const maint = h('div', { class: 'card' }, h('h2', {}, 'Maintenance'),
    h('p', { class: 'muted' }, 'Factory reset restores every profile, key map, macro and lighting setting to defaults.'),
    h('button', { class: 'danger', onclick: async () => {
      if (!confirm('Reset the keyboard to factory defaults? This cannot be undone.')) return;
      await busy('Resetting keyboard', async () => {
        await S.kb.factoryReset();
        forgetSavedMatrices();
        S.loaded.clear();
        saveSlotMap(deviceKey(), {}); // the keyboard's macro slots are empty now
        toast('Keyboard reset to factory defaults');
        await loadSettings();
        S.loaded.add('settings');
      }, 5);
    } }, 'Factory reset'),
    h('p', { class: 'muted small', style: 'margin-top:12px' }, 'Firmware updates are not supported by Akko Cloud.'));

  grid.replaceChildren(sleepCard, perf, optCard, maint); // power saving first, factory reset last
}

// ================================================================== BACKUP
$('#exportBtn').addEventListener('click', () => busy('Exporting backup', async (p) => {
  const kb = S.kb;
  p.steps = (S.model.profiles + S.model.fnLayers) * 8 + 14;
  const data = { format: 'akko-web-driver/1', model: S.model.name, id: S.id, created: new Date().toISOString(), profiles: [], fn: [], macros: {} };
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
  const macroIdx = new Set();
  for (let p = 0; p < S.model.profiles; p++) {
    const m = await kb.getKeyMatrix(p);
    for (let i = 0; i < 128; i++) if (m[i * 4] === 9) macroIdx.add(m[i * 4 + 2]);
    data.profiles.push({ matrix: hex(m) });
  }
  for (let f = 0; f < S.model.fnLayers; f++) {
    const m = await kb.getFnMatrix(f);
    for (let i = 0; i < 128; i++) if (m[i * 4] === 9) macroIdx.add(m[i * 4 + 2]);
    data.fn.push(hex(m));
  }
  if (!kb.dongle) for (const i of [...macroIdx].sort((a, b) => a - b)) data.macros[i] = await kb.getMacro(i);
  else data.macrosSkipped = true;
  data.current = {
    profile: S.profile, light: await kb.getLight(), logo: S.model.logo ? await kb.getLogoLight() : undefined,
    picture: hex(await kb.getUserPicture()), options: await kb.getKeyboardOption(), reportRate: await kb.getReportRate(),
    debounce: await kb.getDebounce(), sleep: await kb.getSleepTime(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `akko-pc75b-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  $('#backupStatus').textContent = kb.dongle
    ? `Exported ${S.model.profiles} profiles and ${S.model.fnLayers} Fn layers. Macros were skipped — they can only be read over the USB cable.`
    : `Exported ${S.model.profiles} profiles, ${S.model.fnLayers} Fn layers and ${macroIdx.size} macros.`;
}, 1));

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
    if (data.format !== 'akko-web-driver/1') throw new Error('Not an Akko Cloud backup');
  } catch (err) {
    toast(err.message, true);
    return;
  }
  if (!confirm(`Restore backup from ${data.created}? This overwrites all key maps, macros and the current lighting.`)) return;
  const unhex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
  await busy('Restoring backup', async (p) => {
    p.steps = (Math.min(data.profiles.length, S.model.profiles) + Math.min(data.fn.length, S.model.fnLayers)) * 17 + Object.keys(data.macros || {}).length * 9 + 15;
    const kb = S.kb;
    forgetSavedMatrices();
    for (let p = 0; p < Math.min(data.profiles.length, S.model.profiles); p++) await kb.setKeyMatrixVerified(unhex(data.profiles[p].matrix), p);
    for (let f = 0; f < Math.min(data.fn.length, S.model.fnLayers); f++) await kb.setFnMatrixVerified(unhex(data.fn[f]), f);
    if (!kb.dongle) for (const [i, m] of Object.entries(data.macros)) await kb.setMacroVerified(Number(i), m.events, m.repeatCount || 1);
    const c = data.current;
    if (c) {
      await kb.setProfile(c.profile ?? 0);
      S.profile = c.profile ?? 0;
      renderProfiles();
      if (c.picture) await kb.setUserPicture(unhex(c.picture));
      if (c.light) await kb.setLight(c.light);
      if (c.logo && S.model.logo) await kb.setLogoLight(c.logo);
      if (c.options) await kb.setKeyboardOption(c.options);
      if (c.reportRate) await kb.setReportRate(c.reportRate);
      if (c.debounce) await kb.setDebounce(c.debounce);
      if (c.sleep) await kb.setSleepTime(c.sleep);
    }
    S.loaded.clear();
    if (!kb.dongle && data.macros) {
      // restored slots no longer hold the library macros that were there
      const map = slotMap();
      for (const k of Object.keys(map)) if (String(map[k]) in data.macros) delete map[k];
      saveSlotMap(deviceKey(), map);
    }
    $('#backupStatus').textContent = kb.dongle && Object.keys(data.macros || {}).length ? 'Backup restored, except macros — restore again over the USB cable to write them.' : 'Backup restored.';
    toast('Backup restored');
  }, 1);
});

// ================================================================== SHORTCUTS
function renderKeybindings() {
  const q = ($('#kbFilter').value || '').trim().toLowerCase();
  const match = (keys, what, section) => !q || [section, what, ...keys].join(' ').toLowerCase().includes(q);
  const out = [];
  for (const sec of KEYBINDING_SECTIONS) {
    const rows = sec.rows.filter(([keys, what]) => match(keys, what, sec.title));
    if (!rows.length) continue;
    out.push(h('section', { class: 'kb-section' }, h('h3', {}, sec.title), sec.note ? h('p', { class: 'note' }, sec.note) : null,
      rows.map(([keys, what]) => h('div', { class: 'kb-row' },
        h('span', { class: 'combo' }, keys.flatMap((k, i) => (i ? ['+', h('kbd', {}, k)] : [h('kbd', {}, k)]))),
        h('span', {}, what)))));
  }
  const list = $('#keybindingsList');
  if (!out.length) {
    list.replaceChildren(h('p', { class: 'muted' }, 'No shortcut matches your search.'));
    return;
  }
  // masonry: as many columns as fit, each section whole in the shortest column
  const n = Math.max(1, Math.min(4, Math.floor((list.clientWidth || 960) / 320)));
  const cols = Array.from({ length: n }, () => ({ el: h('div', { class: 'kb-col' }), size: 0 }));
  out.forEach((sec, i) => {
    const col = cols.reduce((a, b) => (b.size < a.size ? b : a));
    col.el.append(sec);
    col.size += 2 + sec.querySelectorAll('.kb-row').length + (sec.querySelector('.note') ? 1.5 : 0) + i * 0.001;
  });
  list.style.setProperty('--cols', n);
  list.replaceChildren(...cols.map((c) => c.el));
}
let kbResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(kbResizeTimer);
  kbResizeTimer = setTimeout(() => { if (currentTab() === 'keybindings') renderKeybindings(); }, 150);
});
$('#kbFilter').addEventListener('input', renderKeybindings);
document.addEventListener('click', (e) => {
  const go = e.target.closest?.('[data-goto]');
  if (go && S.kb) selectTab(go.dataset.goto);
});

// ================================================================== LOG
const LOG_MAX = 3000;
function logLine(line) {
  if (!S.logging) return;
  S.logLines.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
  if (S.logLines.length > LOG_MAX) S.logLines.splice(0, S.logLines.length - LOG_MAX);
  if (currentTab() === 'log') renderLog();
}
function logPacket(dir, data) {
  logLine(`${dir} ${fmtHex(data)}`);
}
// what the app was doing, between the packets
function logNote(text) {
  logLine(`## ${text}`);
}
function renderLog() {
  const out = $('#logOut');
  out.textContent = S.logLines.slice(-400).join('\n') || (S.logging ? 'Recording… waiting for traffic.' : 'Turn on “Record packets” to start recording.');
  out.scrollTop = out.scrollHeight;
}
$('#logToggle').addEventListener('change', (e) => {
  if (!e.target.checked) logNote('recording stopped');
  S.logging = e.target.checked;
  if (S.logging) logNote('recording started');
  renderLog();
});
$('#logClearBtn').addEventListener('click', () => { S.logLines = []; renderLog(); });
function downloadLog() {
  const head = [
    `Akko Cloud debug log, ${new Date().toISOString()}`,
    `Keyboard: ${S.kb ? `${modelName()} (id ${S.id & 0x7fffffff}), firmware ${S.fw ?? '?'}, ${S.transport?.dongle ? '2.4 GHz receiver' : S.transport?.kind}` : 'not connected'}`,
    `Browser: ${navigator.userAgent}`,
    '',
  ];
  const a = h('a', { href: URL.createObjectURL(new Blob([[...head, ...S.logLines].join('\n')], { type: 'text/plain' })), download: `akko-cloud-log-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt` });
  document.body.append(a);
  a.click();
  a.remove();
}
$('#logDownloadBtn').addEventListener('click', downloadLog);
// the Debug tab only exists once connected, so a failed connect offers the log here
$('#connectLogBtn').addEventListener('click', downloadLog);

window.addEventListener('beforeunload', (e) => {
  if (isDirty() || macrosView.isDirty()) e.preventDefault();
});

initConnect();
const params = new URLSearchParams(location.search);
if (params.has('demo')) connect(new DemoTransport(MODELS[0], { latencyMs: Number(params.get('latency')) || 0 }));
