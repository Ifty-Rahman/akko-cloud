// Small outline icons (24×24, 2px stroke, currentColor) used on keycaps.

const P = {
  speaker: 'M4 9h3l5-4v14l-5-4H4z',
  waveSmall: 'M15.5 9.5a3.5 3.5 0 0 1 0 5',
  waveBig: 'M18.5 6.5a7.5 7.5 0 0 1 0 11',
};

const ICONS = {
  volUp: `<path d="${P.speaker}"/><path d="${P.waveSmall}"/><path d="${P.waveBig}"/>`,
  volDown: `<path d="${P.speaker}"/><path d="${P.waveSmall}"/>`,
  mute: `<path d="${P.speaker}"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>`,
  playPause: '<path d="M4 6l8 6-8 6z"/><path d="M16 6v12M20 6v12"/>',
  next: '<path d="M5 6l9 6-9 6z"/><path d="M18 6v12"/>',
  prev: '<path d="M19 6l-9 6 9 6z"/><path d="M6 6v12"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  brightUp: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  brightDown: '<circle cx="12" cy="12" r="3.5"/><path d="M12 5.5v1M12 17.5v1M5.5 12h1M17.5 12h1M7.4 7.4l.7.7M15.9 15.9l.7.7M7.4 16.6l.7-.7M15.9 8.1l.7-.7"/>',
  calculator: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6 8.5-6"/>',
  computer: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>',
  home: '<path d="M3.5 11L12 4l8.5 7"/><path d="M6 9.5V20h12V9.5"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  power: '<path d="M12 3v8"/><path d="M7.1 6.6a7.5 7.5 0 1 0 9.8 0"/>',
  sleep: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  wake: '<circle cx="12" cy="14" r="3.5"/><path d="M12 3.5v4M9.5 6L12 3.5 14.5 6M4.5 14H6M18 14h1.5M3 20h18"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/>',
  windows: '<rect x="3" y="7" width="12" height="10" rx="1.5"/><path d="M8 4h11.5A1.5 1.5 0 0 1 21 5.5V13"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 7v5M9.5 9.5L12 12l2.5-2.5M8 20h8"/>',
  zoomIn: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5M10.5 8v5M8 10.5h5"/>',
  zoomOut: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5M8 10.5h5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  knob: '<circle cx="12" cy="12" r="4"/><path d="M4.5 9a8 8 0 0 1 13-3.4M19.5 15a8 8 0 0 1-13 3.4"/><path d="M17.5 2.5v3.3h-3.3M6.5 21.5v-3.3h3.3"/>',
  zap: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5M3 17l9 5 9-5"/>',
  layersUp: '<path d="M12 6l8 4.5-8 4.5-8-4.5z"/><path d="M4 15l8 4.5 8-4.5"/><path d="M12 1.5v3"/>',
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v6"/>',
  mouseLeft: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v6M6.5 9H12V3.2A6 6 0 0 0 6.5 9z" fill="currentColor"/>',
  mouseRight: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v6M17.5 9H12V3.2A6 6 0 0 1 17.5 9z" fill="currentColor"/>',
  mouseMiddle: '<rect x="6" y="3" width="12" height="18" rx="6"/><rect x="10.8" y="5" width="2.4" height="4.5" rx="1.2" fill="currentColor"/>',
  scrollUp: '<rect x="7" y="7" width="10" height="14" rx="5"/><path d="M12 7v4M9 4l3-2.5L15 4"/>',
  scrollDown: '<rect x="7" y="3" width="10" height="14" rx="5"/><path d="M12 3v4M9 20l3 2.5 3-2.5"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  combo: '<rect x="2.5" y="7" width="8" height="10" rx="2"/><rect x="13.5" y="7" width="8" height="10" rx="2"/><path d="M12 10.5v3M10.5 12h3" stroke-width="1.6"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  macro: '<path d="M4 7h11M4 12h8M4 17h6"/><path d="M15 12.5l6 3.75-6 3.75z"/>',
  rotateLeft: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 3.5v4.2h4.2"/>',
  rotateRight: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M20 3.5v4.2h-4.2"/>',
  knobPress: '<circle cx="12" cy="14" r="6.5"/><path d="M12 2v5M9.5 4.5L12 7l2.5-2.5"/>',
  disabled: '<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>',
  // macro library / editor
  share: '<path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5"/>',
  upload: '<path d="M12 4v11.5M7.5 11.5L12 16l4.5-4.5"/><path d="M4.5 19.5h15"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4.5h5v2M6.5 6.5l1 13.5h9l1-13.5M10 10.5v6M14 10.5v6"/>',
  plusCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>',
  folderPlus: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/><path d="M12 10.5v5.5M9.25 13.25h5.5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  caretDown: '<path d="M6 9h12l-6 7z" fill="currentColor"/>',
  caretUp: '<path d="M6 15h12l-6-7z" fill="currentColor"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4"/><path d="M12 16.8h.01"/>',
};

export function icon(name, cls = 'ki') {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const hasIcon = (name) => name in ICONS;
