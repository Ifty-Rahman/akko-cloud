// Macros tab: a local macro library (left) and an editor with recordable step
// tiles (right), modelled on the vendor driver's macro page.

import {
  MODES, loadLibrary, saveLibrary, newId, uniqueName, validateMacro, finalizeMacro, mergeDelays,
  macroSize, exportMacroJSON, parseMacroJSON, loadSlotMap, saveSlotMap, macroIdForSlot,
} from './macro-library.js';
import { MACRO_LIMIT, CODE_TO_HID, hidName, SHORT_NAMES } from './codec.js';
import { icon } from './icons.js';

const MOUSE_BUTTONS = { 0: 240, 2: 241, 1: 242, 3: 243, 4: 244 }; // DOM button -> macro code
const MOUSE_NAMES = { 240: 'Left click', 241: 'Right click', 242: 'Middle click', 243: 'Back', 244: 'Forward' };

export function createMacrosView(d) {
  const { h, $, toast, busy, S } = d;
  const V = {
    lib: loadLibrary(),
    sel: undefined, // selected macro id
    edit: undefined, // working copy { name, mode, repeat, events }
    dirty: false,
    fix: false,
    fixMs: 10,
    rec: undefined,
    tile: undefined, // selected tile index
  };

  const persist = () => {
    if (!saveLibrary(V.lib)) toast('Could not save the macro library in this browser', true);
  };
  const byId = (id) => V.lib.macros.find((m) => m.id === id);
  const deviceId = () => (S.id === undefined ? 'none' : S.id & 0x7fffffff);

  // ------------------------------------------------------------ context menu
  let menuEl;
  function closeMenu() {
    menuEl?.remove();
    menuEl = undefined;
  }
  function openMenu(x, y, items) {
    closeMenu();
    menuEl = h('div', { class: 'ctx-menu', role: 'menu' },
      items.filter(Boolean).map((it) => (it === '-' ? h('div', { class: 'ctx-sep' })
        : h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', disabled: it.disabled, onclick: () => { closeMenu(); it.run(); } }, it.label))));
    document.body.append(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.min(x, window.innerWidth - r.width - 8) + window.scrollX}px`;
    menuEl.style.top = `${Math.min(y, window.innerHeight - r.height - 8) + window.scrollY}px`;
    menuEl.querySelector('button:not(:disabled)')?.focus();
  }
  document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('blur', closeMenu);

  // ------------------------------------------------------------ library ops
  function confirmDiscard() {
    return !V.dirty || confirm('Discard unsaved changes to this macro?');
  }

  function newMacro(folderId = null) {
    if (!confirmDiscard()) return;
    stopRecording();
    const m = { id: newId(), name: uniqueName(V.lib.macros.map((x) => x.name), 'Macro'), folderId, mode: 'repeat_times', repeat: 1, events: [], updated: Date.now() };
    V.lib.macros.push(m);
    persist();
    select(m.id, true);
  }

  function newFolder() {
    const name = uniqueName(V.lib.folders.map((f) => f.name), 'Folder');
    V.lib.folders.push({ id: newId(), name, open: true });
    persist();
    renderLib();
    startRename('folder', V.lib.folders[V.lib.folders.length - 1].id);
  }

  function select(id, force) {
    if (id === V.sel && !force) return;
    if (!force && !confirmDiscard()) return;
    stopRecording();
    V.sel = id;
    const m = byId(id);
    V.edit = m ? { name: m.name, mode: m.mode, repeat: m.repeat, events: m.events.map((e) => ({ ...e })) } : undefined;
    V.dirty = false;
    V.tile = undefined;
    render();
  }

  function deleteMacro(id) {
    const m = byId(id);
    if (!m || !confirm(`Delete “${m.name}” from your library?${slotOf(id) !== undefined ? '\nKeys that already use it keep working on the keyboard.' : ''}`)) return;
    V.lib.macros = V.lib.macros.filter((x) => x.id !== id);
    persist();
    if (V.sel === id) {
      V.sel = undefined;
      V.edit = undefined;
      V.dirty = false;
    }
    render();
  }

  function deleteFolder(id) {
    const f = V.lib.folders.find((x) => x.id === id);
    if (!f || !confirm(`Delete folder “${f.name}”? Its macros move to the top level.`)) return;
    V.lib.folders = V.lib.folders.filter((x) => x.id !== id);
    V.lib.macros.forEach((m) => { if (m.folderId === id) m.folderId = null; });
    persist();
    renderLib();
  }

  function moveTo(id, folderId) {
    const m = byId(id);
    if (!m) return;
    m.folderId = folderId;
    const f = V.lib.folders.find((x) => x.id === folderId);
    if (f) f.open = true;
    persist();
    renderLib();
  }

  function exportMacro(id) {
    const m = byId(id);
    if (!m) return;
    const a = h('a', { href: URL.createObjectURL(new Blob([exportMacroJSON(m)], { type: 'application/json' })), download: `${m.name.replace(/[^\w.-]+/g, '_')}.akko-macro.json` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function importMacros() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const list = parseMacroJSON(await file.text());
        for (const x of list) {
          const name = V.lib.macros.some((m) => m.name === x.name) ? uniqueName(V.lib.macros.map((m) => m.name), x.name) : x.name;
          V.lib.macros.push({ ...x, name, id: newId(), folderId: null, updated: Date.now() });
        }
        persist();
        renderLib();
        toast(`Imported ${list.length} macro${list.length === 1 ? '' : 's'}`);
      } catch (e) {
        toast(e.message, true);
      }
    });
    input.click();
  }

  // ------------------------------------------------------------ rename inline
  function startRename(kind, id) {
    const row = $(`#macroLib [data-${kind}="${id}"] .lib-name`);
    if (!row) return;
    const item = kind === 'folder' ? V.lib.folders.find((f) => f.id === id) : byId(id);
    const input = h('input', { type: 'text', class: 'lib-rename', value: item.name, maxLength: 40 });
    const finish = (ok) => {
      const v = input.value.trim();
      if (ok && v) {
        item.name = v;
        if (kind === 'macro' && id === V.sel && V.edit) V.edit.name = v;
        persist();
      }
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    row.replaceWith(input);
    input.focus();
    input.select();
  }

  // add a macro read from the keyboard to the library
  function adoptItem(m) {
    const name = V.lib.macros.some((x) => x.name === m.name) ? uniqueName(V.lib.macros.map((x) => x.name), m.name) : m.name;
    const item = { id: newId(), name, folderId: null, mode: m.mode, repeat: m.repeat, events: m.events, updated: 0 };
    V.lib.macros.push(item);
    persist();
    return item;
  }

  // ------------------------------------------------------------ keyboard scan
  // Macros stored on the keyboard that are not in this browser's library
  // (written from another browser or the vendor app, or before the library
  // existed) are read once per connection and added to the library.
  const headIsEmpty = (page) => page.slice(2).every((b) => b === 0);
  async function scanKeyboard() {
    const kb = S.kb;
    if (!kb || V.scannedFor === kb) return;
    V.scannedFor = kb;
    const max = S.model.maxMacros;
    V.scan = { done: 0, total: max, found: 0 };
    renderLib();
    try {
      for (let slotIdx = 0; slotIdx < max; slotIdx++) {
        if (S.kb !== kb) return; // disconnected
        V.scan.done = slotIdx;
        renderScan();
        const map = loadSlotMap(deviceId());
        if (Object.values(map).includes(slotIdx)) continue; // already known (or deliberately removed)
        if (headIsEmpty(await kb.getMacroHead(slotIdx))) continue;
        const got = await kb.getMacro(slotIdx);
        if (!got.events.length) continue;
        const item = adoptItem({ name: `Keyboard macro ${slotIdx + 1}`, mode: d.modeForSlot?.(slotIdx) ?? 'repeat_times', repeat: Math.max(1, got.repeatCount || 1), events: got.events });
        const fresh = loadSlotMap(deviceId());
        fresh[item.id] = slotIdx;
        saveSlotMap(deviceId(), fresh);
        V.scan.found++;
        if (!V.edit) select(item.id, true);
        else renderLib();
      }
    } catch (e) {
      V.scannedFor = undefined; // try again next time the tab opens
      toast(`Could not finish checking the keyboard for macros: ${e.message}`, true);
    } finally {
      const found = V.scan?.found;
      V.scan = undefined;
      if ($('#macroLib')) renderLib();
      if (found) toast(`Found ${found} macro${found === 1 ? '' : 's'} on the keyboard and added ${found === 1 ? 'it' : 'them'} to your library`);
    }
  }
  function renderScan() {
    const el = $('#macroLib .lib-scan');
    if (el && V.scan) el.lastChild.textContent = `Checking the keyboard for macros… ${V.scan.done + 1}/${V.scan.total}`;
  }

  // ------------------------------------------------------------ library panel
  function slotOf(id) {
    const s = loadSlotMap(deviceId())[id];
    return s === undefined ? undefined : s;
  }

  function macroRow(m) {
    const slot = S.kb ? slotOf(m.id) : undefined;
    return h('div', {
      class: `lib-item${m.id === V.sel ? ' active' : ''}`, 'data-macro': m.id, role: 'button', tabindex: 0,
      onclick: (e) => { if (!e.target.closest('.lib-actions')) select(m.id); },
      ondblclick: () => startRename('macro', m.id),
      onkeydown: (e) => { if (e.key === 'Enter') select(m.id); if (e.key === 'F2') startRename('macro', m.id); },
      oncontextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, [
          { label: 'Rename', run: () => startRename('macro', m.id) },
          ...(V.lib.folders.length || m.folderId ? ['-'] : []),
          ...V.lib.folders.filter((f) => f.id !== m.folderId).map((f) => ({ label: `Move to “${f.name}”`, run: () => moveTo(m.id, f.id) })),
          m.folderId ? { label: 'Move out of folder', run: () => moveTo(m.id, null) } : null,
          '-',
          { label: 'Export…', run: () => exportMacro(m.id) },
          { label: 'Delete', danger: true, run: () => deleteMacro(m.id) },
        ]);
      },
    },
    h('span', { class: 'lib-text' }, h('span', { class: 'lib-name' }, m.name),
      slot !== undefined ? h('span', { class: 'lib-sub', title: 'This macro is stored on the keyboard. Saving changes updates it there too.' }, 'On keyboard') : null),
    h('span', { class: 'lib-actions' },
      h('button', { type: 'button', class: 'icon-btn', title: 'Export', 'aria-label': `Export ${m.name}`, innerHTML: icon('share'), onclick: () => exportMacro(m.id) }),
      h('button', { type: 'button', class: 'icon-btn', title: 'Delete', 'aria-label': `Delete ${m.name}`, innerHTML: icon('trash'), onclick: () => deleteMacro(m.id) })));
  }

  function renderLib() {
    const box = $('#macroLib');
    const top = box.querySelector('.lib-list')?.scrollTop ?? 0;
    const sorted = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const list = h('div', { class: 'lib-list scroll-gutter' },
      sorted(V.lib.folders).map((f) => {
        const kids = sorted(V.lib.macros.filter((m) => m.folderId === f.id));
        return h('div', { class: 'lib-folder' },
          h('div', {
            class: 'lib-item folder', 'data-folder': f.id, role: 'button', tabindex: 0,
            onclick: (e) => { if (e.target.closest('.lib-actions')) return; f.open = !f.open; persist(); renderLib(); },
            ondblclick: () => startRename('folder', f.id),
            oncontextmenu: (e) => {
              e.preventDefault();
              e.stopPropagation();
              openMenu(e.clientX, e.clientY, [
                { label: 'New macro here', run: () => newMacro(f.id) },
                { label: 'Rename folder', run: () => startRename('folder', f.id) },
                '-',
                { label: 'Delete folder', danger: true, run: () => deleteFolder(f.id) },
              ]);
            },
          },
          h('span', { class: `chev${f.open ? ' open' : ''}`, innerHTML: icon('chevron') }),
          h('span', { class: 'folder-ic', innerHTML: icon('folder') }),
          h('span', { class: 'lib-name' }, f.name),
          h('span', { class: 'lib-count' }, String(kids.length)),
          h('span', { class: 'lib-actions' },
            h('button', { type: 'button', class: 'icon-btn', title: 'Delete folder', 'aria-label': `Delete folder ${f.name}`, innerHTML: icon('trash'), onclick: () => deleteFolder(f.id) }))),
          f.open ? h('div', { class: 'lib-children' }, kids.length ? kids.map(macroRow) : h('p', { class: 'lib-empty' }, 'Empty folder')) : null);
      }),
      sorted(V.lib.macros.filter((m) => !m.folderId || !V.lib.folders.some((f) => f.id === m.folderId))).map(macroRow),
      !V.lib.macros.length && !V.lib.folders.length && !V.scan ? h('p', { class: 'lib-empty big' }, 'No macros yet. Click + or right-click here to create one.') : null);
    list.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY, [
        { label: 'New macro', run: () => newMacro() },
        { label: 'New folder', run: newFolder },
        '-',
        { label: 'Import macro…', run: importMacros },
      ]);
    });
    box.replaceChildren(...[
      h('div', { class: 'lib-head' },
        h('h2', {}, 'Macros'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'icon-btn', title: 'New macro', 'aria-label': 'New macro', innerHTML: icon('plusCircle'), onclick: () => newMacro() }),
        h('button', { type: 'button', class: 'icon-btn', title: 'New folder', 'aria-label': 'New folder', innerHTML: icon('folderPlus'), onclick: newFolder }),
        h('button', { type: 'button', class: 'icon-btn', title: 'Import macro', 'aria-label': 'Import macro', innerHTML: icon('upload'), onclick: importMacros })),
      V.scan ? h('p', { class: 'lib-scan' }, h('span', { class: 'spinner small' }), `Checking the keyboard for macros… ${V.scan.done + 1}/${V.scan.total}`) : null,
      list,
      h('p', { class: 'lib-foot' }, 'Saved in this browser. Macros already on the keyboard are added automatically. Assign a macro to a key on the Keys tab to put it on the keyboard.'),
    ].filter(Boolean));
    list.scrollTop = top;
  }

  // ------------------------------------------------------------ recording
  function recPush(ev) {
    const now = performance.now();
    const evs = V.edit.events;
    if (evs.length && V.rec.last !== undefined) {
      const ms = V.fix ? V.fixMs : Math.round(now - V.rec.last);
      evs.push({ type: 'delay', value: Math.max(1, Math.min(65535, ms)) });
    }
    V.rec.last = now;
    evs.push(ev);
    V.dirty = true;
    renderTiles(true);
  }

  function onRecKey(e) {
    if (e.repeat) { e.preventDefault(); return; }
    const hid = CODE_TO_HID[e.code];
    if (!hid) return;
    e.preventDefault();
    e.stopPropagation();
    recPush({ type: 'keyboard', action: e.type === 'keydown' ? 'down' : 'up', value: hid });
  }

  function onRecMouse(e) {
    const surface = $('#macroTiles');
    if (!surface?.contains(e.target)) return; // only clicks inside the recording area
    const code = MOUSE_BUTTONS[e.button];
    if (!code) return;
    e.preventDefault();
    recPush({ type: 'mouse_button', action: e.type === 'mousedown' ? 'down' : 'up', value: code });
  }
  const blockMenu = (e) => { if ($('#macroTiles')?.contains(e.target)) e.preventDefault(); };

  function startRecording() {
    if (!V.edit) return;
    V.rec = { last: undefined };
    window.addEventListener('keydown', onRecKey, true);
    window.addEventListener('keyup', onRecKey, true);
    document.addEventListener('mousedown', onRecMouse, true);
    document.addEventListener('mouseup', onRecMouse, true);
    document.addEventListener('contextmenu', blockMenu, true);
    renderEditor();
  }

  function stopRecording() {
    if (!V.rec) return;
    window.removeEventListener('keydown', onRecKey, true);
    window.removeEventListener('keyup', onRecKey, true);
    document.removeEventListener('mousedown', onRecMouse, true);
    document.removeEventListener('mouseup', onRecMouse, true);
    document.removeEventListener('contextmenu', blockMenu, true);
    V.rec = undefined;
    if (V.edit) V.edit.events = mergeDelays(V.edit.events);
    if ($('#macroEdit')) renderEditor();
  }

  // ------------------------------------------------------------ editing ops
  const fixDelay = () => (V.fix ? V.fixMs : 50);
  function insertAt(i, ...evs) {
    V.edit.events.splice(i, 0, ...evs);
    V.dirty = true;
  }
  function deleteTile(i) {
    const evs = V.edit.events;
    // like the vendor: removing a key step also removes the delay that follows it
    if (evs[i].type !== 'delay' && evs[i + 1]?.type === 'delay') evs.splice(i, 2);
    else evs.splice(i, 1);
    V.edit.events = mergeDelays(evs);
    V.dirty = true;
    V.tile = undefined;
    renderTiles();
  }

  function captureKey(onHid) {
    toast('Press the key to add…');
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', handler, true);
      const hid = CODE_TO_HID[e.code];
      if (hid) onHid(hid);
      else toast(`That key (${e.code}) can’t be used in a macro`, true);
    };
    window.addEventListener('keydown', handler, true);
  }

  // inserts a press/release pair with delays around it, like the vendor's Add
  function insertStep(at, kind, value) {
    const evs = V.edit.events;
    const gap = () => ({ type: 'delay', value: fixDelay() });
    const before = at > 0 && evs[at - 1].type !== 'delay' ? [gap()] : [];
    const after = at < evs.length && evs[at].type !== 'delay' ? [gap()] : [];
    insertAt(at, ...before, { type: kind, action: 'down', value }, gap(), { type: kind, action: 'up', value }, ...after);
    V.edit.events = mergeDelays(V.edit.events);
    renderTiles(at >= evs.length - 1);
  }
  const addKeyPress = (at = V.edit.events.length) => captureKey((hid) => insertStep(at, 'keyboard', hid));
  const addClick = (code, at = V.edit.events.length) => insertStep(at, 'mouse_button', code);
  function addDelay(at = V.edit.events.length) {
    insertAt(at, { type: 'delay', value: fixDelay() });
    V.edit.events = mergeDelays(V.edit.events);
    renderTiles(true);
  }

  // ------------------------------------------------------------ tiles
  function tileFor(ev, i) {
    const selected = V.tile === i;
    const common = {
      'data-i': i, tabindex: 0, role: 'button',
      class: `mtile ${ev.type === 'delay' ? 'delay' : ev.type === 'mouse_move' ? 'move' : 'mt-key'}${ev.action === 'up' ? ' up' : ''}${selected ? ' selected' : ''}`,
      onclick: () => { V.tile = selected ? undefined : i; renderTiles(); },
      onkeydown: (e) => { if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteTile(i); } },
      oncontextmenu: (e) => {
        if (V.rec) return;
        e.preventDefault();
        V.tile = i;
        renderTiles();
        openMenu(e.clientX, e.clientY, [
          { label: 'Insert key press after…', run: () => addKeyPress(i + 1) },
          { label: 'Insert delay after', run: () => addDelay(i + 1) },
          '-',
          { label: 'Delete', danger: true, run: () => deleteTile(i) },
        ]);
      },
    };
    const del = h('button', { type: 'button', class: 'mtile-del', title: 'Delete step', 'aria-label': 'Delete step', onclick: (e) => { e.stopPropagation(); deleteTile(i); } }, '×');
    if (ev.type === 'delay') {
      return h('div', { ...common, title: `Wait ${ev.value} ms` }, h('span', { class: 'mt-top' }, String(ev.value)), h('span', { class: 'mt-rule' }), h('span', { class: 'mt-bot' }, 'ms'), del);
    }
    if (ev.type === 'mouse_move') {
      return h('div', { ...common, title: `Move mouse ${ev.dx}, ${ev.dy}` }, h('span', { class: 'mt-ic', innerHTML: icon('mouse') }), h('span', { class: 'mt-bot' }, `${ev.dx},${ev.dy}`), del);
    }
    const name = ev.type === 'keyboard' ? hidName(ev.value) : MOUSE_NAMES[ev.value] ?? 'Mouse';
    const short = ev.type === 'keyboard' ? (SHORT_NAMES[ev.value] ?? hidName(ev.value)) : null;
    const top = ev.type === 'mouse_button'
      ? h('span', { class: 'mt-ic', innerHTML: icon({ 240: 'mouseLeft', 241: 'mouseRight', 242: 'mouseMiddle', 243: 'arrowLeft', 244: 'arrowRight' }[ev.value] || 'mouse') })
      : h('span', { class: 'mt-top' }, ev.value ? short : '?');
    return h('div', { ...common, title: `${name} ${ev.action === 'down' ? 'pressed' : 'released'}` },
      top, h('span', { class: 'mt-arrow', innerHTML: icon(ev.action === 'down' ? 'caretDown' : 'caretUp') }), del);
  }

  function tileEditor() {
    const i = V.tile;
    const ev = V.edit.events[i];
    if (!ev) return null;
    if (ev.type === 'delay') {
      const inp = h('input', { type: 'number', min: 1, max: 65535, value: ev.value, 'aria-label': 'Delay in milliseconds' });
      inp.addEventListener('change', () => { ev.value = Math.max(1, Math.min(65535, Math.round(Number(inp.value)) || 1)); V.dirty = true; renderTiles(); });
      return h('div', { class: 'tile-edit' }, h('span', {}, 'Wait'), inp, h('span', { class: 'muted' }, 'ms'),
        h('button', { type: 'button', class: 'ghost danger', onclick: () => deleteTile(i) }, 'Delete'));
    }
    if (ev.type === 'keyboard' || ev.type === 'mouse_button') {
      const flip = h('button', { type: 'button', onclick: () => { ev.action = ev.action === 'down' ? 'up' : 'down'; V.dirty = true; renderTiles(); } }, ev.action === 'down' ? 'Make it a release ▲' : 'Make it a press ▼');
      const change = ev.type === 'keyboard' ? h('button', { type: 'button', onclick: () => captureKey((hid) => { ev.value = hid; V.dirty = true; renderTiles(); }) }, 'Change key…') : null;
      return h('div', { class: 'tile-edit' }, h('b', {}, ev.type === 'keyboard' ? hidName(ev.value) : MOUSE_NAMES[ev.value]), h('span', { class: 'muted' }, ev.action === 'down' ? 'pressed' : 'released'), change, flip,
        h('button', { type: 'button', class: 'ghost danger', onclick: () => deleteTile(i) }, 'Delete'));
    }
    return h('div', { class: 'tile-edit' }, h('span', {}, 'Mouse move'), h('button', { type: 'button', class: 'ghost danger', onclick: () => deleteTile(i) }, 'Delete'));
  }

  function renderTiles(scrollToEnd = false) {
    const surface = $('#macroTiles');
    if (!surface) return;
    const top = surface.scrollTop;
    const evs = V.edit.events;
    surface.replaceChildren(
      ...(evs.length ? evs.map(tileFor) : [h('p', { class: 'tiles-empty' }, V.rec ? 'Recording… press keys, or click inside this area.' : 'No steps yet. Press Record, or use Add.')]),
    );
    surface.classList.toggle('recording', !!V.rec);
    surface.scrollTop = scrollToEnd ? surface.scrollHeight : top;
    $('#tileEditor')?.replaceChildren(...(V.tile !== undefined && !V.rec ? [tileEditor()].filter(Boolean) : []));
    renderMeta();
  }

  function renderMeta() {
    const meta = $('#macroMeta');
    if (!meta || !V.edit) return;
    const size = macroSize(finalizeMacro(V.edit.events, fixDelay()));
    const full = size > MACRO_LIMIT;
    meta.replaceChildren(...[
      h('div', { class: 'usage' + (full ? ' full' : '') }, h('i', { style: `width:${Math.min(100, (size / MACRO_LIMIT) * 100)}%` })),
      h('span', { class: `small ${full ? 'err' : 'muted'}` }, full ? `Too long for the keyboard (${size} / ${MACRO_LIMIT} bytes)` : `${Number.isFinite(size) ? size : '—'} / ${MACRO_LIMIT} bytes`),
      V.dirty ? h('span', { class: 'dirty small' }, 'Unsaved') : null,
    ].filter(Boolean));
  }

  // ------------------------------------------------------------ editor
  function setMode(id) {
    if (V.rec) return;
    V.edit.mode = id;
    V.dirty = true;
    renderEditor();
  }

  async function save() {
    stopRecording();
    const err = validateMacro(V.edit.events);
    if (err) return toast(err, true);
    const events = finalizeMacro(V.edit.events, fixDelay());
    if (macroSize(events) > MACRO_LIMIT) return toast(`The macro is too long for the keyboard (max ${MACRO_LIMIT} bytes). Remove some steps.`, true);
    const m = byId(V.sel);
    Object.assign(m, { name: V.edit.name.trim() || m.name, mode: V.edit.mode, repeat: V.edit.mode === 'repeat_times' ? V.edit.repeat : 1, events, updated: Date.now() });
    V.edit = { name: m.name, mode: m.mode, repeat: m.repeat, events: events.map((e) => ({ ...e })) };
    V.dirty = false;
    persist();
    render();
    // already on the keyboard? keep it in sync
    const slot = S.kb ? slotOf(m.id) : undefined;
    if (slot !== undefined) {
      await busy('Updating the macro on the keyboard…', async () => {
        await d.writeMacroToKeyboard(m, slot);
        toast(`Saved and updated on the keyboard (slot ${slot + 1})`);
      });
    } else {
      toast('Macro saved');
    }
  }

  function renderEditor() {
    const box = $('#macroEdit');
    if (!V.edit) {
      box.replaceChildren(h('div', { class: 'macro-empty' },
        h('span', { class: 'big-ic', innerHTML: icon('macro') }),
        h('h2', {}, V.lib.macros.length ? 'Select a macro' : 'Create your first macro'),
        h('p', { class: 'muted' }, 'Record a sequence of key presses and mouse clicks, then assign it to any key on the Keys tab.'),
        h('button', { class: 'primary', onclick: () => newMacro() }, 'New macro')));
      return;
    }
    const e = V.edit;
    const modeBox = (m) => h('label', { class: `mode-opt${e.mode === m.id ? ' on' : ''}`, title: m.hint },
      h('input', { type: 'checkbox', checked: e.mode === m.id, disabled: !!V.rec, onchange: () => setMode(m.id) }), h('span', {}, m.label));
    const loopCount = h('input', { type: 'number', class: 'small-num', min: 1, max: 999, value: e.repeat, disabled: e.mode !== 'repeat_times' || !!V.rec, 'aria-label': 'Loop count',
      onchange: (ev) => { e.repeat = Math.max(1, Math.min(999, Math.round(Number(ev.target.value)) || 1)); ev.target.value = e.repeat; V.dirty = true; renderMeta(); } });
    const name = h('input', { type: 'text', class: 'macro-name', value: e.name, maxLength: 40, 'aria-label': 'Macro name',
      oninput: (ev) => { e.name = ev.target.value; V.dirty = true; renderMeta(); } });
    const fixToggle = h('input', { type: 'checkbox', checked: V.fix, disabled: !!V.rec, onchange: (ev) => { V.fix = ev.target.checked; fixMs.disabled = !V.fix; } });
    const fixMs = h('input', { type: 'number', class: 'small-num', min: 1, max: 65535, value: V.fixMs, disabled: !V.fix || !!V.rec, 'aria-label': 'Fixed delay',
      onchange: (ev) => { V.fixMs = Math.max(1, Math.min(65535, Math.round(Number(ev.target.value)) || 1)); ev.target.value = V.fixMs; } });
    const addBtn = h('button', { type: 'button', disabled: !!V.rec, onclick: (ev) => {
      const r = ev.currentTarget.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4, [
        { label: 'Key press…', run: () => addKeyPress() },
        { label: 'Delay', run: () => addDelay() },
        '-',
        { label: 'Left click', run: () => addClick(240) },
        { label: 'Right click', run: () => addClick(241) },
        { label: 'Middle click', run: () => addClick(242) },
      ]);
    } }, 'Add', h('span', { class: 'btn-caret', innerHTML: icon('chevron') }));
    const recBtn = h('button', { type: 'button', class: V.rec ? 'rec-on' : '', onclick: () => (V.rec ? stopRecording() : startRecording()) },
      h('span', { class: 'rec-dot' }), V.rec ? 'Stop' : 'Record');
    const help = h('button', { type: 'button', class: `icon-btn${V.help ? ' on' : ''}`, title: 'How macros work', 'aria-label': 'How macros work', 'aria-expanded': String(!!V.help), innerHTML: icon('help'),
      onclick: () => { V.help = !V.help; renderEditor(); } });
    const helpBox = V.help ? h('div', { class: 'macro-help' },
      h('p', {}, h('b', {}, 'Record'), ' captures the keys you type and the mouse clicks you make inside the step area, with the real time between them. Press ', h('b', {}, 'Stop'), ' when done.'),
      h('p', {}, h('b', {}, 'Fix'), ' replaces the recorded timing with the same delay between every step.'),
      h('p', {}, h('b', {}, 'Add'), ' inserts a key press, a click or a delay at the end. Click a step to change it; right-click it for more.'),
      h('p', {}, h('b', {}, 'Loop'), ' plays the macro the set number of times. ', h('b', {}, 'Toggle with the key'), ' starts looping on one press and stops on the next. ', h('b', {}, 'Press to play'), ' repeats while the key is held.'),
      h('p', {}, 'Assign the macro to a key on the Keys tab. It is written to the keyboard together with the key map.')) : null;
    box.replaceChildren(...[
      h('div', { class: 'macro-top' }, name, h('span', { class: 'spacer' }), help),
      helpBox,
      h('div', { class: 'mode-row' }, h('span', { class: 'loop-group' }, modeBox(MODES[0]), loopCount), h('span', { class: 'mode-sep' }), modeBox(MODES[1]), modeBox(MODES[2])),
      h('div', { class: 'macro-tools' }, recBtn, addBtn,
        h('span', { class: 'fix-group' }, h('label', { class: `mode-opt fix${V.fix ? ' on' : ''}`, title: 'Use the same delay between every step' }, fixToggle, h('span', {}, 'Fix')), fixMs, h('span', { class: 'muted' }, 'ms')),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'ghost', disabled: !!V.rec || !e.events.length, onclick: () => { if (confirm('Remove all steps?')) { e.events = []; V.dirty = true; V.tile = undefined; renderTiles(); } } }, 'Clear'),
        h('button', { type: 'button', class: 'primary', disabled: !!V.rec, onclick: save }, 'Save')),
      h('div', { id: 'macroTiles', class: 'mtiles scroll-gutter' }),
      h('div', { id: 'tileEditor', class: 'tile-editor' }),
      h('div', { id: 'macroMeta', class: 'macro-meta' }),
    ].filter(Boolean));
    renderTiles();
  }

  function render() {
    scanKeyboard();
    // open the most recently edited macro rather than an empty editor
    if (!V.edit || !byId(V.sel)) {
      const last = [...V.lib.macros].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
      V.sel = last?.id;
      V.edit = last ? { name: last.name, mode: last.mode, repeat: last.repeat, events: last.events.map((e) => ({ ...e })) } : undefined;
      V.dirty = false;
      V.tile = undefined;
    }
    renderLib();
    renderEditor();
  }

  return {
    render,
    stop: stopRecording,
    library: () => V.lib,
    reload() { V.lib = loadLibrary(); render(); },
    isDirty: () => V.dirty,
    macroForSlot: (slot) => byId(macroIdForSlot(loadSlotMap(deviceId()), slot)),
    adopt: adoptItem,
    select,
  };
}
