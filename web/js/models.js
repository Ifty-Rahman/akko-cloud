// Device definitions recovered from Akko Cloud Driver 370.1.54
// (device tables + protocol classes DJ / Bce / Ece / Ise, all extending the
// "rongyuan_k_rgb" yc200 class chain). See docs/PROTOCOL.md.

// USB identities the PC75B family enumerates with. The configuration
// interface is the keyboard collection (usage page 0x01, usage 0x06) which
// carries a 64-byte vendor feature report with report ID 0.
export const USB_IDS = [
  { vendorId: 0x3151, productId: 0x4003, label: 'USB (yc300)' },
  { vendorId: 0x0461, productId: 0x4003, label: 'USB (yc200)' },
  { vendorId: 0x05ac, productId: 0x024f, label: 'USB (Mac mode)' },
  { vendorId: 0x25a7, productId: 0x2420, label: '2.4 GHz receiver', dongle: true },
];

export const CONFIG_USAGE_PAGE = 0x01;
export const CONFIG_USAGE = 0x06;

// Default key matrix of the PC75B (class DJ; identical for Bce/Ece).
// 128 slots x 4 bytes, column-major: index = column * 6 + row.
const PC75B_MATRIX = [0,0,41,0,0,0,53,0,0,0,43,0,0,0,57,0,0,0,225,0,0,0,224,0,0,0,58,0,0,0,30,0,0,0,20,0,0,0,4,0,0,0,100,0,0,0,0,0,0,0,59,0,0,0,31,0,0,0,26,0,0,0,22,0,0,0,29,0,0,0,227,0,0,0,60,0,0,0,32,0,0,0,8,0,0,0,7,0,0,0,27,0,0,0,226,0,0,0,61,0,0,0,33,0,0,0,21,0,0,0,9,0,0,0,6,0,0,0,0,0,0,0,62,0,0,0,34,0,0,0,23,0,0,0,10,0,0,0,25,0,0,0,0,0,0,0,63,0,0,0,35,0,0,0,28,0,0,0,11,0,0,0,5,0,0,0,44,0,0,0,64,0,0,0,36,0,0,0,24,0,0,0,13,0,0,0,17,0,0,0,0,0,0,0,65,0,0,0,37,0,0,0,12,0,0,0,14,0,0,0,16,0,0,0,230,0,0,0,66,0,0,0,38,0,0,0,18,0,0,0,15,0,0,0,54,0,10,1,0,0,0,0,67,0,0,0,39,0,0,0,19,0,0,0,51,0,0,0,55,0,0,0,0,0,0,0,68,0,0,0,45,0,0,0,47,0,0,0,52,0,0,0,56,0,0,0,228,0,0,0,69,0,0,0,46,0,0,0,48,0,0,0,50,0,0,0,229,0,0,0,80,0,0,0,76,0,0,0,42,0,0,0,49,0,0,0,40,0,0,0,82,0,0,0,81,0,10,15,0,0,0,0,74,0,0,0,75,0,0,0,78,0,0,0,77,0,0,0,79,0,3,0,233,0,3,0,234,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,13,2,1,0,13,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];

// Mac white variant (class Ise): right GUI where Fn was, Fn where RCtrl was.
const PC75B_MAC_MATRIX = PC75B_MATRIX.slice();
PC75B_MAC_MATRIX.splice(59 * 4, 4, 0, 0, 231, 0);
PC75B_MAC_MATRIX.splice(71 * 4, 4, 10, 1, 0, 0);

// Lighting effects exposed for the PC75B family (layout "Wy").
export const MAIN_LIGHT_TYPES = [
  { type: 'LightOff' },
  { type: 'LightAlwaysOn', rgb: true },
  { type: 'LightBreath', speed: true, rgb: true },
  { type: 'LightMeteor', speed: true, rgb: true },
  { type: 'LightRipple', speed: true, rgb: true },
  { type: 'LightTrain', speed: true, rgb: true },
  { type: 'LightRainDown', speed: true, rgb: true },
  { type: 'LightConverage', speed: true, rgb: true },
  { type: 'LightSnake', speed: true, rgb: true, options: ['z', 'return'] },
  { type: 'LightNeon', speed: true },
  { type: 'LightWave', speed: true, rgb: true, options: ['down', 'up'] },
  { type: 'LightRaindrop', speed: true, rgb: true },
  { type: 'LightPressAction', speed: true, rgb: true },
  { type: 'LightSineWave', speed: true, rgb: true },
  { type: 'LightKaleidoscope', speed: true, rgb: true, options: ['out', 'in'] },
  { type: 'LightLineWave', speed: true, rgb: true },
  { type: 'LightLaser', speed: true, rgb: true },
  { type: 'LightCircleWave', speed: true, rgb: true, options: ['anti-clockwise', 'clockwise'] },
  { type: 'LightDazzing', speed: true, rgb: true },
  { type: 'LightPressActionOff', speed: true, rgb: true },
  { type: 'LightFireWorks', speed: true, rgb: true, options: ['right', 'left'] },
  { type: 'LightUserPicture' },
  { type: 'LightMusicFollow3', rgb: true, options: ['upright', 'separate', 'intersect'], host: 'music' },
  { type: 'LightMusicFollow2', rgb: true, options: ['upright', 'separate', 'intersect'], host: 'music' },
  { type: 'LightScreenColor', host: 'screen', noValue: true },
];

// Logo / side LED effects (logo layout "Rc"). The music and screen modes of
// that layout are written to the main LED command by the original driver, so
// they are intentionally not offered for the logo strip here.
export const LOGO_LIGHT_TYPES = [
  { type: 'LightOff' },
  { type: 'LightAlwaysOn', rgb: true },
  { type: 'LightBreath', speed: true, rgb: true },
  { type: 'LightNeon', speed: true },
  { type: 'LightSnake', speed: true, rgb: true },
  { type: 'LightWave', speed: true, rgb: true },
];

export const LIGHT_NAMES = {
  LightOff: 'Off',
  LightAlwaysOn: 'Static',
  LightBreath: 'Breathing',
  LightMeteor: 'Meteor',
  LightRipple: 'Ripple',
  LightTrain: 'Train',
  LightRainDown: 'Rain down',
  LightConverage: 'Converge',
  LightSnake: 'Snake',
  LightNeon: 'Neon',
  LightWave: 'Wave',
  LightRaindrop: 'Raindrop',
  LightPressAction: 'Reactive',
  LightSineWave: 'Sine wave',
  LightKaleidoscope: 'Kaleidoscope',
  LightLineWave: 'Line wave',
  LightLaser: 'Laser',
  LightCircleWave: 'Circle wave',
  LightDazzing: 'Dazzle',
  LightPressActionOff: 'Reactive (fade out)',
  LightFireWorks: 'Fireworks',
  LightUserPicture: 'Custom per-key',
  LightMusicFollow3: 'Music rhythm 1',
  LightMusicFollow2: 'Music rhythm 2',
  LightScreenColor: 'Screen colour sync',
  LightUserColor: 'User colour',
};

const COMMON = {
  profiles: 4, // device "layer": 4
  fnLayers: 2, // device "fnLayer": 2
  reportRates: [125, 250, 500, 1000],
  debounce: { min: 1, max: 10 },
  sleep: { min: 1, max: 60, minDeep: 10, maxDeep: 60 }, // minutes
  maxMacros: 20,
};

// Model ids are reported by the keyboard itself (command 0x8F). Over the
// 2.4 GHz receiver the id carries bit 31 (0x80000000).
// Colour-mode codes (see protocol.js VENDOR_COLOUR_CODES). Verified on a
// PC75B Plus+ (id 594): the firmware treats 7 as rainbow and 8 as solid colour.
const PLUS_PLUS_COLOURS = { rainbow: 7, solid: 8 };

export const MODELS = [
  { ids: [413, 281], name: 'yc200_pc75b', displayName: 'Akko PC75B Plus', matrix: PC75B_MATRIX, logo: true },
  { ids: [594], name: 'yc300_pc75_s_plus', displayName: 'Akko PC75B Plus+', matrix: PC75B_MATRIX, logo: true, colourCodes: PLUS_PLUS_COLOURS },
  { ids: [695], name: 'yc300_pc75_s_white_plus', displayName: 'Akko PC75B Plus+ (White)', matrix: PC75B_MATRIX, logo: true, colourCodes: PLUS_PLUS_COLOURS },
  { ids: [658], name: 'yc300_pc75_s_mac_white_plus', displayName: 'Akko PC75B Plus+ (Mac, White)', matrix: PC75B_MAC_MATRIX, logo: true, colourCodes: PLUS_PLUS_COLOURS },
  { ids: [1374], name: 'yc300_pc75_s_mac_white_plus', displayName: 'Akko PC75B Plus+ (Mac, White)', matrix: PC75B_MAC_MATRIX, logo: false, colourCodes: PLUS_PLUS_COLOURS },
].map((m) => ({ ...COMMON, ...m }));

export const FALLBACK_MODEL = {
  ...COMMON,
  ids: [],
  name: 'unknown_pc75b',
  displayName: 'Akko PC75B (unrecognised id)',
  matrix: PC75B_MATRIX,
  logo: true,
};

export function findModel(id) {
  if (id === undefined || id === null) return FALLBACK_MODEL;
  const plain = id & 0x7fffffff;
  return MODELS.find((m) => m.ids.includes(plain)) || { ...FALLBACK_MODEL, unknownId: id };
}

export function isDongle(vendorId, productId) {
  return USB_IDS.some((u) => u.dongle && u.vendorId === vendorId && u.productId === productId);
}

// Physical layout of the 75% board. x/y/w in key units; idx = matrix index.
// Labels are derived at render time from the model's default matrix so the
// Mac variant shows its own legends.
const R = (y, keys) => keys.map(([idx, x, w = 1]) => ({ idx, x, y, w }));
export const LAYOUT = [
  ...R(0, [[0, 0], [6, 1.25], [12, 2.25], [18, 3.25], [24, 4.25], [30, 5.5], [36, 6.5], [42, 7.5], [48, 8.5], [54, 9.75], [60, 10.75], [66, 11.75], [72, 12.75], [78, 14]]),
  ...R(1.25, [[1, 0], [7, 1], [13, 2], [19, 3], [25, 4], [31, 5], [37, 6], [43, 7], [49, 8], [55, 9], [61, 10], [67, 11], [73, 12], [79, 13, 2], [85, 15.25]]),
  ...R(2.25, [[2, 0, 1.5], [8, 1.5], [14, 2.5], [20, 3.5], [26, 4.5], [32, 5.5], [38, 6.5], [44, 7.5], [50, 8.5], [56, 9.5], [62, 10.5], [68, 11.5], [74, 12.5], [80, 13.5, 1.5], [86, 15.25]]),
  ...R(3.25, [[3, 0, 1.75], [9, 1.75], [15, 2.75], [21, 3.75], [27, 4.75], [33, 5.75], [39, 6.75], [45, 7.75], [51, 8.75], [57, 9.75], [63, 10.75], [69, 11.75], [81, 12.75, 2.25], [87, 15.25]]),
  ...R(4.25, [[4, 0, 2.25], [16, 2.25], [22, 3.25], [28, 4.25], [34, 5.25], [40, 6.25], [46, 7.25], [52, 8.25], [58, 9.25], [64, 10.25], [70, 11.25], [76, 12.25, 1.75], [82, 14.25], [88, 15.25]]),
  ...R(5.25, [[5, 0, 1.25], [17, 1.25, 1.25], [23, 2.5, 1.25], [41, 3.75, 6.25], [53, 10], [59, 11], [71, 12], [77, 13.25], [83, 14.25], [89, 15.25]]),
];
export const LAYOUT_WIDTH = 16.25;
export const LAYOUT_HEIGHT = 6.25;

// Matrix slots that are not ordinary keys on the ANSI board.
export const KNOB = { press: 84, clockwise: 90, counterClockwise: 91, x: 15.25, y: 0 };
export const EXTRA_SLOTS = [
  { idx: 10, label: 'ISO \\ (next to LShift)' },
  { idx: 75, label: 'ISO # (next to Enter)' },
  { idx: 96, label: 'Matrix slot 96' },
  { idx: 97, label: 'Matrix slot 97' },
];
