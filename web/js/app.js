import {
  LAYOUT, KNOB, EXTRA_SLOTS, MAIN_LIGHT_TYPES, LOGO_LIGHT_TYPES, LIGHT_NAMES, MODELS, findModel,
} from './models.js';
import {
  HID_NAMES, CODE_TO_HID, FUNCTION_ACTIONS, MOUSE_ACTIONS, MACRO_MODES, MACRO_LIMIT,
  encodeAction, decodeAction, describeAction, shortLabel, hidName, macroByteLength, rgbToHex, hexToRgb,
} from './codec.js';
import { Keyboard } from './protocol.js';
import { WebHidTransport, DemoTransport } from './transports.js';
import { MusicFollower, ScreenFollower } from './host-effects.js';
import { KEYBINDING_SECTIONS } from './keybindings.js';

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
  toastTimer = setTimeout(() => t.classList.remove('show'), error ? 6000 : 2600);
}

async function busy(text, fn) {
  $('#busyText').textContent = text;
  $('#busy').hidden = false;
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e?.message || String(e), true);
    return undefined;
  } finally {
    $('#busy').hidden = true;
  }
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
  macroIndex: 0,
  macro: { events: [], repeatCount: 1 },
  macroCache: new Map(),
  loaded: new Set(),
  logging: false,
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
    hint.textContent = 'Pick the keyboard in the browser prompt. On Linux, install the udev rule from the project README first.';
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
  await busy('Connecting…', async () => {
    try {
      await transport.open();
    } catch (e) {
      if (transport.kind === 'usb' && /failed to open/i.test(e?.message || '')) {
        throw new Error(/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)
          ? 'The browser is not allowed to open the keyboard. On Linux install deploy/70-akko-keyboard.rules (see README), then unplug and replug the keyboard.'
          : 'The keyboard could not be opened. Close the Akko Cloud Driver or any other configurator using it, then try again.');
      }
      throw e;
    }
    const kb = new Keyboard(transport, { dongle: transport.dongle, log: logPacket });
    let busyLabel;
    kb.onAsleep = (asleep) => {
      const el = $('#busyText');
      if (asleep) {
        busyLabel = el.textContent;
        el.textContent = 'Keyboard is asleep — press any key on it to wake it…';
        if ($('#busy').hidden) toast('Keyboard is asleep — press any key on it', true);
      } else if (busyLabel) el.textContent = busyLabel;
    };
    const id = await kb.getDeviceId();
    const fw = await kb.getFirmwareVersion().catch(() => undefined);
    const profile = await kb.getProfile().catch(() => 0);
    if (transport.dongle) await kb.getLinkStatus().catch(() => undefined);
    Object.assign(S, {
      kb, transport, id, fw, profile, model: findModel(id), layer: 'base', selected: undefined,
      loaded: new Set(), macroCache: new Map(),
    });
    transport.onDisconnect(() => {
      toast('Keyboard disconnected', true);
      disconnect();
    });
    showApp();
  });
}

async function disconnect() {
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
  $('#deviceName').textContent = m.displayName;
  const sel = $('#profileSelect');
  sel.replaceChildren(...Array.from({ length: m.profiles }, (_, i) => h('option', { value: i }, `${i + 1}`)));
  sel.value = String(S.profile);
  const link = { usb: 'USB (this device)', demo: 'Demo (simulated)' }[S.transport.kind];
  const fw = S.fw !== undefined ? `v${(S.fw >> 8).toString(16)}.${(S.fw & 255).toString(16).padStart(2, '0')}` : '—';
  $('#deviceStrip').replaceChildren(
    h('span', {}, 'Model ', h('b', {}, m.displayName)),
    h('span', {}, 'Device id ', h('b', {}, `${S.id & 0x7fffffff}${S.id & 0x80000000 ? ' (2.4 GHz)' : ''}`)),
    h('span', {}, 'Firmware ', h('b', {}, fw)),
    h('span', {}, 'Link ', h('b', {}, link + (S.transport.dongle ? ' · 2.4 GHz receiver' : ''))),
    ...(S.kb.battery !== undefined ? [h('span', {}, 'Battery ', h('b', {}, `${S.kb.battery}%`))] : []),
  );
  if (S.transport.dongle) toast('Connected through the 2.4 GHz receiver. Akko officially supports customisation over the USB cable — use it if a change does not stick.');
  if (m.unknownId !== undefined) toast(`Unrecognised model id ${m.unknownId}. Using the standard PC75B layout.`, true);
  selectTab('keys');
}

$('#profileSelect').addEventListener('change', async (e) => {
  const p = Number(e.target.value);
  await busy(`Switching to profile ${p + 1}…`, async () => {
    await S.kb.setProfile(p);
    S.profile = p;
    S.loaded.clear();
    S.selected = undefined;
    await loadTab(currentTab());
  });
});

// ------------------------------------------------------------------ tabs
const currentTab = () => $('#tabs [aria-selected="true"]').dataset.tab;
$$('#tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
function selectTab(name) {
  $$('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
  loadTab(name);
}
async function loadTab(name) {
  if (!S.kb) return;
  if (S.loaded.has(name)) return;
  const loaders = { keys: loadKeys, lighting: loadLighting, macros: loadMacros, settings: loadSettings, keybindings: async () => renderKeybindings(), backup: async () => {}, log: async () => renderLog() };
  const ok = await busy('Reading from keyboard…', async () => {
    await loaders[name]();
    return true;
  });
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
  if (idx === KNOB.clockwise) return 'Knob turn right';
  if (idx === KNOB.counterClockwise) return 'Knob turn left';
  const ex = EXTRA_SLOTS.find((e) => e.idx === idx);
  if (ex) return ex.label;
  return describeAction(decodeAction(slot(S.model.matrix, idx)));
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
      await busy('Reading layer…', readLayer);
    },
  }, l.label)));
  await readLayer();
}

async function readLayer() {
  const m = S.layer === 'base' ? await S.kb.getKeyMatrix(S.profile) : await S.kb.getFnMatrix(Number(S.layer.slice(2)));
  S.orig = Uint8Array.from(m);
  S.work = Uint8Array.from(m);
  renderKeys();
  renderEditor();
}

const isDirty = () => S.orig && S.work && !eqBytes(Array.from(S.orig), Array.from(S.work));
function updateDirty() {
  const d = isDirty();
  $('#keysDirty').hidden = !d;
  $('#keysWriteBtn').disabled = !d;
}

function keyLabel(idx) {
  const b = slot(S.work, idx);
  if (isFnLayer() && eqBytes(b, [0, 0, 0, 0])) return { text: '', fnDefault: true };
  return { text: shortLabel(b), special: decodeAction(b).type !== 'key' };
}

function renderKeys() {
  const kb = $('#kbKeys');
  kb.replaceChildren();
  for (const k of LAYOUT) {
    const lab = keyLabel(k.idx);
    const changed = !eqBytes(slot(S.work, k.idx), slot(S.orig, k.idx));
    const remapped = !isFnLayer() && !eqBytes(slot(S.work, k.idx), slot(S.model.matrix, k.idx));
    const el = h('button', {
      class: ['key', changed && 'changed', S.selected === k.idx && 'selected', (lab.special || remapped) && 'special'].filter(Boolean).join(' '),
      style: `--x:${k.x};--y:${k.y};--w:${k.w}`,
      title: `${slotName(k.idx)} → ${lab.fnDefault ? 'firmware default' : describeAction(decodeAction(slot(S.work, k.idx)))}`,
      onclick: () => selectKey(k.idx),
    }, h('span', {}, lab.text === '★' ? describeAction(decodeAction(slot(S.work, k.idx))).slice(0, 10) : lab.text));
    kb.append(el);
  }
  kb.append(h('button', {
    class: 'knob' + (S.selected === KNOB.press ? ' selected' : ''),
    title: 'Knob press',
    onclick: () => selectKey(KNOB.press),
  }, '⟳'));
  const extras = $('#extraSlots');
  const chips = [
    { idx: KNOB.clockwise, label: 'Knob ↻' },
    { idx: KNOB.counterClockwise, label: 'Knob ↺' },
    { idx: KNOB.press, label: 'Knob press' },
    ...EXTRA_SLOTS.map((e) => ({ idx: e.idx, label: e.label })),
  ];
  extras.replaceChildren(...chips.map((c) => {
    const changed = !eqBytes(slot(S.work, c.idx), slot(S.orig, c.idx));
    return h('button', {
      class: ['chip', S.selected === c.idx && 'selected', changed && 'changed'].filter(Boolean).join(' '),
      onclick: () => selectKey(c.idx),
    }, `${c.label}: ${keyLabel(c.idx).fnDefault ? 'default' : describeAction(decodeAction(slot(S.work, c.idx)))}`);
  }));
  updateDirty();
}

function selectKey(idx) {
  S.selected = idx;
  renderKeys();
  renderEditor();
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
    ['macro', 'Macro'], ['disabled', isFnLayer() ? 'Firmware default (clear)' : 'Disabled'], ['raw', 'Raw bytes (advanced)'],
  ];
  const typeSel = h('select', {}, kinds.map(([v, l]) => h('option', { value: v, selected: v === cur.type }, l)));
  const body = h('div', { class: 'grid' });
  let read = () => ({ type: 'disabled' });

  function build() {
    const t = typeSel.value;
    body.replaceChildren();
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
      const sl = h('select', {}, range(0, S.model.maxMacros - 1).map((i) => h('option', { value: i, selected: cur.index === i }, `Macro ${i + 1}`)));
      const md = h('select', {}, MACRO_MODES.map((m) => h('option', { value: m.id, selected: cur.mode === m.id }, m.label)));
      body.append(h('label', { class: 'field' }, h('span', {}, 'Macro slot'), sl), h('label', { class: 'field' }, h('span', {}, 'Playback'), md),
        h('p', { class: 'muted small' }, 'Edit the macro contents on the Macros tab.'));
      read = () => ({ type: 'macro', index: Number(sl.value), mode: md.value });
    } else if (t === 'disabled') {
      body.append(h('p', { class: 'muted' }, isFnLayer() ? 'The key keeps its built-in Fn behaviour.' : 'The key will do nothing.'));
      read = () => ({ type: 'disabled' });
    } else {
      const inp = h('input', { type: 'text', value: fmtHex(slot(S.work, idx)), spellcheck: false });
      body.append(h('label', { class: 'field' }, h('span', {}, '4 bytes, hex'), inp));
      read = () => {
        const bytes = inp.value.trim().split(/[\s,]+/).map((x) => parseInt(x, 16));
        if (bytes.length !== 4 || bytes.some((b) => !(b >= 0 && b <= 255))) throw new Error('Enter exactly 4 hex bytes');
        return { type: 'raw', bytes };
      };
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
      h('span', { class: 'now' }, 'currently: ', h('b', {}, fnDefault ? 'firmware default' : describeAction(cur)))),
    h('div', { class: 'grid' }, h('label', { class: 'field' }, h('span', {}, 'Action type'), typeSel)),
    h('div', { style: 'height:12px' }),
    body,
    h('div', { class: 'editor-actions' },
      h('button', { class: 'primary', onclick: apply }, 'Apply to key'),
      h('button', { class: 'ghost', onclick: restore }, isFnLayer() ? 'Clear' : 'Restore default'),
      h('span', { class: 'muted small' }, 'Changes are staged until you press “Write to keyboard”.')),
  );
}

$('#keysWriteBtn').addEventListener('click', () => busy('Writing key map…', async () => {
  if (S.layer === 'base') await S.kb.setKeyMatrix(S.work, S.profile);
  else await S.kb.setFnMatrix(S.work, Number(S.layer.slice(2)));
  S.orig = Uint8Array.from(S.work);
  renderKeys();
  toast('Key map saved to keyboard');
}));
$('#keysReloadBtn').addEventListener('click', () => busy('Reading layer…', readLayer));
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
  S.pic = await S.kb.getUserPicture();
  renderLightCard($('#mainLightCard'), 'Key backlight', MAIN_LIGHT_TYPES, S.light, async (l) => {
    await S.kb.setLight(l);
    S.light = l;
    updateHostCard();
  });
  if (S.model.logo) {
    renderLightCard($('#logoLightCard'), 'PC case light (RGB strip)', LOGO_LIGHT_TYPES, S.logo ?? { type: 'LightOff' }, async (l) => {
      await S.kb.setLogoLight(l);
      S.logo = l;
    });
  } else {
    $('#logoLightCard').replaceChildren(h('h2', {}, 'PC case light (RGB strip)'), h('p', { class: 'muted' }, 'This model has no separately controllable case light.'));
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
  const preview = h('div', { class: 'swatch' });

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
      const color = h('input', { type: 'color', value: rgbToHex(draft.rgb), disabled: !!draft.dazzle, oninput: (e) => { draft.rgb = hexToRgb(e.target.value).value; preview.style.background = e.target.value; } });
      preview.style.background = draft.dazzle ? 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' : rgbToHex(draft.rgb);
      const rainbow = h('label', { class: 'switch' }, h('input', {
        type: 'checkbox', checked: !!draft.dazzle,
        onchange: (e) => {
          draft.dazzle = e.target.checked;
          color.disabled = draft.dazzle;
          preview.style.background = draft.dazzle ? 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' : rgbToHex(draft.rgb);
        },
      }), h('span', {}, 'Rainbow colours'));
      area.append(h('div', { class: 'inline' }, preview, color, rainbow));
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
      h('div', {}, h('button', { class: 'primary', onclick: () => busy(`Applying ${title.toLowerCase()}…`, async () => { await onApply({ ...draft }); toast(`${title} updated`); }) }, 'Apply'))),
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
$('#picFillBtn').addEventListener('click', () => {
  const { r, g, b } = hexToRgb($('#brushColor').value);
  for (const k of LAYOUT) S.pic.set([r, g, b], k.idx * 3);
  renderPaint();
});
$('#picClearBtn').addEventListener('click', () => { S.pic.fill(0); renderPaint(); });
$('#picLoadBtn').addEventListener('click', () => busy('Reading colours…', async () => { S.pic = await S.kb.getUserPicture(); renderPaint(); }));
$('#picWriteBtn').addEventListener('click', () => busy('Writing per-key colours…', async () => {
  await S.kb.setUserPicture(S.pic);
  const l = { type: 'LightUserPicture', value: S.light?.value ?? 4 };
  await S.kb.setLight(l);
  S.light = l;
  renderLightCard($('#mainLightCard'), 'Backlight', MAIN_LIGHT_TYPES, S.light, async (x) => { await S.kb.setLight(x); S.light = x; updateHostCard(); });
  updateHostCard();
  toast('Custom colours active');
}));

// ================================================================== MACROS
async function loadMacros() {
  renderMacroSlots();
  await openMacro(S.macroIndex);
}

function renderMacroSlots() {
  const ul = $('#macroSlotList');
  ul.replaceChildren(...range(0, S.model.maxMacros - 1).map((i) => {
    const m = S.macroCache.get(i);
    const info = m ? (m.events.length ? `${m.events.filter((e) => e.type !== 'delay').length} steps` : 'empty') : '';
    return h('li', {}, h('button', { class: i === S.macroIndex ? 'active' : '', onclick: () => busy('Reading macro…', () => openMacro(i)) },
      h('span', {}, `Macro ${i + 1}`), h('span', { class: 'muted small' }, info)));
  }));
}

async function openMacro(i) {
  S.macroIndex = i;
  if (!S.macroCache.has(i)) S.macroCache.set(i, await S.kb.getMacro(i));
  const m = S.macroCache.get(i);
  S.macro = { events: m.events.map((e) => ({ ...e })), repeatCount: Math.max(1, m.repeatCount || 1) };
  renderMacroSlots();
  renderMacroEditor();
}

let recorder;
function renderMacroEditor() {
  const ed = $('#macroEditor');
  const m = S.macro;
  let used = 0;
  try { used = macroByteLength(m.events); } catch { used = Infinity; }
  const full = used > MACRO_LIMIT;
  const list = h('ul', { class: 'events' }, m.events.map((ev, i) => {
    const del = h('button', { class: 'ghost', title: 'Remove', onclick: () => { m.events.splice(i, 1); renderMacroEditor(); } }, '✕');
    const up = h('button', { class: 'ghost', title: 'Move up', disabled: i === 0, onclick: () => { [m.events[i - 1], m.events[i]] = [m.events[i], m.events[i - 1]]; renderMacroEditor(); } }, '↑');
    if (ev.type === 'delay') {
      return h('li', {}, h('span', { class: 'tag delay' }, 'wait'),
        h('input', { type: 'number', min: 1, max: 65535, value: ev.value, onchange: (e) => { ev.value = Math.max(1, Math.min(65535, Number(e.target.value) || 1)); renderMacroEditor(); } }),
        h('span', { class: 'grow muted' }, 'ms'), up, del);
    }
    const name = ev.type === 'keyboard' ? hidName(ev.value)
      : ev.type === 'mouse_button' ? (MOUSE_ACTIONS.find((x) => x.code === ev.value)?.label ?? `Mouse ${ev.value}`)
      : `Mouse move ${ev.dx}, ${ev.dy}`;
    return h('li', {}, h('span', { class: `tag ${ev.action === 'up' ? 'up' : ''}` }, ev.action ?? 'move'), h('span', { class: 'grow' }, name), up, del);
  }));

  const rec = h('button', { class: recorder ? 'danger' : '', onclick: toggleRecord }, recorder ? '■ Stop recording' : '● Record');
  const addKey = captureButton((hid) => {
    m.events.push({ type: 'keyboard', action: 'down', value: hid }, { type: 'delay', value: 20 }, { type: 'keyboard', action: 'up', value: hid });
    renderMacroEditor();
  });
  addKey.textContent = '+ Key press';
  const mouseSel = h('select', {}, MOUSE_ACTIONS.filter((x) => x.code).map((x) => h('option', { value: x.code }, x.label)));
  ed.replaceChildren(
    h('div', { class: 'card-head' }, h('h2', {}, `Macro ${S.macroIndex + 1}`), h('span', { class: 'spacer' }),
      recorder ? h('span', { class: 'recording' }, 'Recording — type on your keyboard') : ''),
    h('div', { class: 'row' }, rec, addKey,
      h('button', { onclick: () => { m.events.push({ type: 'delay', value: 50 }); renderMacroEditor(); } }, '+ Delay'),
      mouseSel, h('button', { onclick: () => { const v = Number(mouseSel.value); m.events.push({ type: 'mouse_button', action: 'down', value: v }, { type: 'delay', value: 20 }, { type: 'mouse_button', action: 'up', value: v }); renderMacroEditor(); } }, '+ Click'),
      h('button', { class: 'ghost', onclick: () => { m.events = []; renderMacroEditor(); } }, 'Clear')),
    list,
    ...(m.events.length ? [] : [h('p', { class: 'muted' }, 'Empty macro. Record keystrokes or add steps.')]),
    h('div', { class: 'row' }, h('label', { class: 'field', style: 'max-width:200px' }, h('span', {}, 'Repeat count (“Play N times” mode)'),
      h('input', { type: 'number', min: 1, max: 65535, value: m.repeatCount, onchange: (e) => (m.repeatCount = Math.max(1, Math.min(65535, Number(e.target.value) || 1))) }))),
    h('div', { class: 'usage' + (full ? ' full' : '') }, h('i', { style: `width:${Math.min(100, (used / MACRO_LIMIT) * 100)}%` })),
    h('p', { class: 'muted small' }, `${Number.isFinite(used) ? used : '>256'} / ${MACRO_LIMIT} bytes`),
    h('div', { class: 'row' }, h('button', { class: 'primary', disabled: full, onclick: saveMacro }, 'Save to keyboard'),
      h('span', { class: 'muted small' }, 'To use it, assign “Macro ' + (S.macroIndex + 1) + '” to a key on the Keys tab.')),
  );
}

function toggleRecord() {
  if (recorder) {
    window.removeEventListener('keydown', recorder.on, true);
    window.removeEventListener('keyup', recorder.on, true);
    recorder = undefined;
    renderMacroEditor();
    return;
  }
  let last;
  const on = (e) => {
    if (e.repeat) { e.preventDefault(); return; }
    const hid = CODE_TO_HID[e.code];
    if (!hid) return;
    e.preventDefault();
    const now = performance.now();
    if (last !== undefined) S.macro.events.push({ type: 'delay', value: Math.max(1, Math.min(65535, Math.round(now - last))) });
    last = now;
    S.macro.events.push({ type: 'keyboard', action: e.type === 'keydown' ? 'down' : 'up', value: hid });
    renderMacroEditor();
  };
  recorder = { on };
  window.addEventListener('keydown', on, true);
  window.addEventListener('keyup', on, true);
  renderMacroEditor();
}

async function saveMacro() {
  if (recorder) toggleRecord();
  await busy('Writing macro…', async () => {
    await S.kb.setMacro(S.macroIndex, S.macro.events, S.macro.repeatCount);
    S.macroCache.set(S.macroIndex, { events: S.macro.events.map((e) => ({ ...e })), repeatCount: S.macro.repeatCount });
    renderMacroSlots();
    toast(`Macro ${S.macroIndex + 1} saved`);
  });
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
    h('label', { class: 'field' }, h('span', {}, 'Polling rate (this profile)'), rateSel),
    h('button', { onclick: () => busy('Setting polling rate…', async () => { await S.kb.setReportRate(Number(rateSel.value)); toast('Polling rate saved'); }) }, 'Apply polling rate'),
    h('label', { class: 'field' }, h('span', {}, 'Debounce (1 = fastest, 10 = most stable): ', debVal), debIn),
    h('button', { onclick: () => busy('Setting debounce…', async () => { await S.kb.setDebounce(Number(debIn.value)); toast('Debounce saved'); }) }, 'Apply debounce')));

  const sleepRow = (label, secs, min, max) => {
    const never = h('input', { type: 'checkbox', checked: secs === 0 });
    const val = h('input', { type: 'number', min, max, value: secs === 0 ? max : Math.round(secs / 60), disabled: secs === 0 });
    never.addEventListener('change', () => (val.disabled = never.checked));
    return { el: h('div', { class: 'inline' }, h('span', { style: 'min-width:150px' }, label), val, h('span', { class: 'muted' }, 'min'), h('label', { class: 'switch' }, never, h('span', {}, 'Never'))),
      get: () => (never.checked ? 0 : Math.max(min, Math.min(max, Number(val.value) || min)) * 60) };
  };
  const rows = {
    rf: sleepRow('2.4 GHz – sleep', sl.rf, m.sleep.min, m.sleep.max),
    deepRf: sleepRow('2.4 GHz – deep sleep', sl.deepRf, m.sleep.minDeep, m.sleep.maxDeep),
    bt: sleepRow('Bluetooth – sleep', sl.bt, m.sleep.min, m.sleep.max),
    deepBt: sleepRow('Bluetooth – deep sleep', sl.deepBt, m.sleep.minDeep, m.sleep.maxDeep),
  };
  const sleepCard = h('div', { class: 'card' }, h('h2', {}, 'Wireless sleep'), h('div', { class: 'form' }, Object.values(rows).map((r) => r.el),
    h('button', { onclick: () => busy('Saving sleep timers…', async () => {
      await S.kb.setSleepTime(Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.get()])));
      toast('Sleep timers saved');
    }) }, 'Apply sleep timers')));

  // Only the switches the PC75B manual documents (Fn + Win, Fn + W). Every
  // other option bit is preserved unchanged on write: the original driver does
  // not expose them and their meaning on this keyboard is not confirmed.
  const toggles = [
    ['winKeyLock', 'Lock Windows key', 'Same as Fn + Left Win on the keyboard.'],
    ['wasdArrowSwap', 'Swap WASD and arrow keys', 'Same as Fn + W on the keyboard.'],
  ];
  const mk = ([k, label, desc]) => h('label', { class: 'switch' }, h('span', {}, label, desc ? h('span', { class: 'desc' }, desc) : null),
    h('input', { type: 'checkbox', checked: !!S.options[k], onchange: (e) => busy('Saving option…', async () => {
      const next = { ...S.options, [k]: e.target.checked };
      await S.kb.setKeyboardOption(next);
      S.options = next;
      toast('Saved');
    }) }));
  const optCard = h('div', { class: 'card' }, h('h2', {}, 'Keyboard options (this profile)'), h('div', { class: 'opt-list' }, toggles.map(mk)),
    h('p', { class: 'muted small', style: 'margin-top:12px' }, `OS mode: ${S.options.macMode ? 'Mac' : 'Windows'}. Set it with the switch on the back of the keyboard (left = Windows, right = Mac).`));

  const maint = h('div', { class: 'card' }, h('h2', {}, 'Maintenance'),
    h('p', { class: 'muted' }, 'Factory reset restores every profile, key map, macro and lighting setting to defaults.'),
    h('button', { class: 'danger', onclick: async () => {
      if (!confirm('Reset the keyboard to factory defaults? This cannot be undone.')) return;
      await busy('Resetting…', async () => {
        await S.kb.factoryReset();
        S.loaded.clear();
        S.macroCache.clear();
        toast('Keyboard reset to factory defaults');
        await loadSettings();
        S.loaded.add('settings');
      });
    } }, 'Factory reset'),
    h('p', { class: 'muted small', style: 'margin-top:12px' }, 'Firmware updates are not supported by Akko Cloud.'));

  grid.replaceChildren(perf, optCard, sleepCard, maint);
}

// ================================================================== BACKUP
$('#exportBtn').addEventListener('click', () => busy('Reading everything from the keyboard…', async () => {
  const kb = S.kb;
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
  for (const i of [...macroIdx].sort((a, b) => a - b)) data.macros[i] = await kb.getMacro(i);
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
  $('#backupStatus').textContent = `Exported ${S.model.profiles} profiles, ${S.model.fnLayers} Fn layers and ${macroIdx.size} macros.`;
}));

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
  await busy('Restoring backup…', async () => {
    const kb = S.kb;
    for (let p = 0; p < Math.min(data.profiles.length, S.model.profiles); p++) await kb.setKeyMatrix(unhex(data.profiles[p].matrix), p);
    for (let f = 0; f < Math.min(data.fn.length, S.model.fnLayers); f++) await kb.setFnMatrix(unhex(data.fn[f]), f);
    for (const [i, m] of Object.entries(data.macros)) await kb.setMacro(Number(i), m.events, m.repeatCount || 1);
    const c = data.current;
    if (c) {
      await kb.setProfile(c.profile ?? 0);
      S.profile = c.profile ?? 0;
      $('#profileSelect').value = String(S.profile);
      if (c.picture) await kb.setUserPicture(unhex(c.picture));
      if (c.light) await kb.setLight(c.light);
      if (c.logo && S.model.logo) await kb.setLogoLight(c.logo);
      if (c.options) await kb.setKeyboardOption(c.options);
      if (c.reportRate) await kb.setReportRate(c.reportRate);
      if (c.debounce) await kb.setDebounce(c.debounce);
      if (c.sleep) await kb.setSleepTime(c.sleep);
    }
    S.loaded.clear();
    S.macroCache.clear();
    $('#backupStatus').textContent = 'Backup restored.';
    toast('Backup restored');
  });
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
  $('#keybindingsList').replaceChildren(...(out.length ? out : [h('p', { class: 'muted' }, 'No shortcut matches your search.')]));
}
$('#kbFilter').addEventListener('input', renderKeybindings);
document.addEventListener('click', (e) => {
  const go = e.target.closest?.('[data-goto]');
  if (go && S.kb) selectTab(go.dataset.goto);
});

// ================================================================== LOG
function logPacket(dir, data) {
  if (!S.logging) return;
  S.logLines.push(`${new Date().toISOString().slice(11, 23)} ${dir} ${fmtHex(data)}`);
  if (S.logLines.length > 600) S.logLines.splice(0, S.logLines.length - 600);
  if (currentTab() === 'log') renderLog();
}
function renderLog() {
  const out = $('#logOut');
  out.textContent = S.logLines.join('\n') || (S.logging ? 'Waiting for traffic…' : 'Enable “Record packets” to capture HID traffic.');
  out.scrollTop = out.scrollHeight;
}
$('#logToggle').addEventListener('change', (e) => { S.logging = e.target.checked; renderLog(); });
$('#logClearBtn').addEventListener('click', () => { S.logLines = []; renderLog(); });

window.addEventListener('beforeunload', (e) => {
  if (isDirty()) e.preventDefault();
});

initConnect();
if (new URLSearchParams(location.search).has('demo')) connect(new DemoTransport(MODELS[0]));
