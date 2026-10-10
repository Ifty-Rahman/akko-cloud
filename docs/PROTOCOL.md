# Akko PC75B configuration protocol

Reverse engineered from **Akko Cloud Driver 370.1.54** (Windows build 2025-07-03 and
macOS build 2025-09-12). This page records how the protocol was recovered and how
much confidence each part carries.

## Where the protocol lives

The vendor app has two parts:

| Part | Technology | Role |
|---|---|---|
| `Akko Cloud Driver.exe` / `.app` | Electron + React (`dist/static/js/main_*.js`, 18 MB) | **Every protocol packet is built here** |
| `iot_driver(.exe)` | Rust (tokio, tonic gRPC-web, hidapi) on `127.0.0.1:3814` | Generic transport: `sendMsg`, `readMsg`, `sendRawFeature`, … plus device discovery, checksums, 2.4 GHz pacing |

The UI calls the helper over gRPC-web (`/driver.DriverGrpc/*`). The helper only
forwards 64-byte buffers to the keyboard and adds a checksum when one is
requested. That split is why a browser (WebHID) can replace the helper entirely.

The PC75B models resolve, through the device factory, to the classes
`DJ` (`yc200_pc75b`), `Bce` (`yc300_pc75_s_plus`), `Ece` (`yc300_pc75_s_white_plus`) and
`Ise` (`yc300_pc75_s_mac_white_plus`). All four extend the same chain,
`cX → PI → nI → WD → jD → hD → KC → RC → aC` (group `rongyuan_k_rgb`). They differ
only in their default key matrix.

## Transport

* USB HID **feature report, report ID 0, 64 data bytes** (65 on the wire), sent on
  the keyboard's top-level collection *Generic Desktop / Keyboard* (usage page
  0x01, usage 0x06). Confirmed on a real receiver: interface 0 descriptor
  `… 05 0c 09 00 … 95 40 75 08 b1 02` (64 × 8-bit feature).
* Every request is "write a feature report, then read a feature report".
  Replies are 64 bytes and usually echo the command in byte 0.
* Pacing used by the vendor app: 10 ms before each write, 5 ms before each
  read (60 ms extra over Bluetooth), 500 ms after
  lighting/option writes, and 1000 ms after key-map, macro and picture uploads.

### Checksums (`proto.driver.CheckSumType`)

Recovered from the Rust helper's disassembly (identical code in three places,
for example at `0x56a0d0` in the Windows build):

| Type | Value | Effect on payload `d[0..63]` |
|---|---|---|
| BIT7 | 0 | `d[7] = 0xFF − (d[0]+…+d[6] & 0xFF)` |
| BIT8 | 1 | `d[8] = 0xFF − (d[0]+…+d[7] & 0xFF)` |
| NONE | 2 | unchanged |

Paged uploads (key matrix, Fn matrix) put the BIT7 value into the header
themselves and send with NONE.

## USB identities and model ids

| VID:PID | Meaning |
|---|---|
| 3151:4003 | PC75B Plus+ (yc300) wired |
| 0461:4003 | PC75B Plus (yc200) wired |
| 05AC:024F | Mac-mode variants (Apple id) |
| 25A7:2420 | 2.4 GHz receiver |

Model identification uses `[0x8F]`, and the reply carries `u32le(d[1..4])`.
Constant `8f` at `0x100520553`, read in
`iot_driver::dj_dev_api::DJDevApi::get_id` (macOS build). Over the receiver the
helper ORs in `0x80000000`, which explains the negative ids in the vendor
device table.

| id | Model |
|---|---|
| 413, 281 | PC75B Plus (`yc200_pc75b`) |
| 594 | PC75B Plus+ |
| 695 | PC75B Plus+ White |
| 658, 1374 | PC75B Plus+ Mac White (1374: no logo LED) |

## Commands

| Cmd | Name | Request | Reply / notes |
|---|---|---|---|
| 0x80 | GET_REV | `[80]` | firmware `u16le(d[1..2])` |
| 0x8F | GET_INFOR | `[8F]` | model id `u32le(d[1..4])` |
| 0x02 | SET_RESET | `[02]` BIT7 | factory reset |
| 0x05 / 0x85 | profile | `[05, p]` BIT7 / `[85]` | `d[1]` = active profile (0–3) |
| 0x04 / 0x84 | report rate | `[04, p, code]` BIT7 / `[84, p]` | code 1=1000, 2=500, 4=250, 8=125 Hz |
| 0x06 / 0x86 | keyboard options | `[06, p, flags, fnMatrix, powerSave]` BIT7 | flags: b0 Win lock, b1 Mac mode (read-only from the app's view), b3 WASD↔arrows, b4 LED off, b5 logo LED off, b6/b7 unlabeled |
| 0x11 / 0x91 | debounce | `[11, 0, v]` BIT7 | `d[2]`, UI range 1–10 |
| 0x12 / 0x92 | sleep timers | write `u16le` at d[8..15]: BT, 2.4G, deep BT, deep 2.4G (seconds, 0 = never) | read: the same four values at d[1..8] |
| 0x07 / 0x87 | main LED | `[07, mode, 4−speed, brightness, opt, R, G, B]` **BIT8** | see below |
| 0x08 / 0x88 | logo LED | `[08, mode, speed, brightness, opt, R, G, B]` **BIT8** | modes 0 off, 1 static, 2 breath, 3 neon, 4 wave, 5 snake |
| 0x09 / 0x89 | key matrix | 9 pages `[09, profile, F8, 01, page, 0, 0, csum] + 56 B` | read 8 × `[89, profile, page]` → 512 B |
| 0x10 / 0x90 | Fn matrix | 9 pages `[10, fn, F8, 01, page, 0, 0, csum] + 56 B` | 2 Fn layers |
| 0x0B / 0x8B | macro | 5 pages `[0B, idx, 0, 1, page, 0, 0, BIT7] + 56 B` | read 4 × `[8B, idx, page]` → 256 B |
| 0x0C / 0x8C | per-key RGB | 7 pages `[0C, 0, 0x80, 0x01, page, 0, 0, BIT7] + 56 B` | read 6 × `[8C, 0, page]` → 384 B (128 × RGB) |
| 0x0D | music frame | `[0D, 0×6, F2, 32 levels 0–6]` | streamed every ~40 ms |
| 0x0E | screen colour | `[0E, R, G, B, A]` BIT7 | streamed every ~40 ms |

### 2.4 GHz receiver (25A7:2420)

Verified on a real receiver paired with a PC75B Plus+ (id 594, firmware 3.10).
The receiver answers its own commands, which are sent without a checksum.
Keyboard replies are not returned directly.

| Cmd | Reply | Meaning |
|---|---|---|
| `[FD]` | `AA 55 01` | receiver present / paired |
| `[FB]` | `d[0]` is_ready_read, `d[1]` battery %, `d[2]` 0 = keyboard online (1 = asleep/out of range), `d[3]` is_write_finish | link status (field names from the helper's `DangleCommonStatus`) |
| `[FC]` | the keyboard's 64-byte reply to the last query | fetch reply |
| `[FE, n]` | – | announce the length of the next streamed packet (music/screen) |

* **Writes**: send → poll `[FB]` until `d[3] = 1`. A write never sets `d[0]`.
* **Queries**: send → poll until `d[0] = 1` → `[FC]` → read the reply.
* `d[2] = 1` means the keyboard is asleep (its 2.4 GHz sleep timer) or out of
  range. The receiver cannot wake it; a key press on the keyboard does. The
  vendor helper polls 15 × 100 ms and then reports an error.
* Delivery normally takes 0.15–0.7 s per packet, and over 1 s when the link is waking up.
* Music frames over the receiver are `[FE, 17]` then `[0D, 16 bytes of two
  4-bit levels]` (no checksum); screen frames are `[FE, 8]` then the normal
  `0E` packet.

### Main LED byte 4 (`opt`)

* Low nibble: `8` = rainbow ("dazzle"), `7` = use the RGB bytes, `0–6` = preset colours.
* High nibble: direction/style. Wave uses right 0, left 1, down 2, up 3.
  Two-way effects use 0 or 1. Music modes use upright 0, separate 1,
  intersect 2, with the low nibble 0 for rainbow and 4 otherwise.
* Pure white is sent as `FA FF FA`.

Modes: 0 off, 1 static, 2 breathing, 3 neon, 4 wave, 5 ripple, 6 raindrop, 7 snake,
8 reactive, 9 converge, 10 sine wave, 11 kaleidoscope, 12 line wave, 13 user picture,
14 laser, 15 circle wave, 16 dazzle, 17 rain down, 18 meteor, 19 reactive-off,
20 music 1, 21 screen colour, 22 music 2, 23 train, 24 fireworks.

### Key matrix

128 slots × 4 bytes, column-major with 6 rows (`index = column × 6 + row`).
Only the first 504 bytes are written. Slot encodings:

| Bytes | Meaning |
|---|---|
| `00 00 hid 00` | key (HID usage) |
| `00 mod hid hid2` | combo; mod = E0 Ctrl, E1 Shift, E2 Alt, E3 Win |
| `00 00 00 00` | disabled (base) / firmware default (Fn layer) |
| `01 00 F0..F8 xx` | mouse button / wheel |
| `02 81..83 00 00` | system power / sleep / wake |
| `03 00 lo hi` | consumer usage (e.g. `03 00 E9 00` volume up) |
| `08 00 n m` | profile switching |
| `09 mode idx 00` | macro (mode 0 = N times, 1 = toggle, 2 = while held) |
| `0A 01 00 00` | Fn; `0A 0F 00 00` = knob press (volume ↔ backlight) |

PC75B knob: press = slot 84, clockwise = slot 90, counter-clockwise = slot 91.

### Macro buffer (256 bytes, at most 248 used)

`u16le repeatCount`, then one entry per action: `code, flags[, u16le delay]`.
The code is a HID usage (4–239), a mouse button (240–244), or 249 for a mouse
move (followed by `dx, dy`). In the flags byte, bit 7 means "key down" and bits
0–6 hold an inline delay of 1–127 ms; when those bits are 0, a 16-bit delay follows.

## How it was verified

* Rebuilt packets were compared byte for byte against the **original vendor
  JavaScript**, executed in isolation. The comparison covered 3000 random
  macros (encode and decode), 4000 main-LED packets, 2000 logo-LED packets and
  200 sleep packets, with 0 mismatches.
* Checksums, the model-id probe and the report framing come from disassembly of
  the Rust helper (Windows i686 and macOS x86_64 builds).
* End-to-end checks on a real PC75B Plus+ (USB and 2.4 GHz receiver) using the
  same `Keyboard` class: model id, firmware, battery, lighting, logo LED, options,
  polling rate, debounce, sleep timers, the full key matrix (user remaps decoded
  correctly), a stored macro, and a full 9-page key-matrix write with
  byte-identical read-back over the receiver.
* `tests/` holds unit tests for every packet builder and the receiver handshake.
