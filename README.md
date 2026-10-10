# Akko Cloud

**Akko Cloud** is a website that configures **Akko PC75B Plus / PC75B Plus+** keyboards. You don't
install the official Akko Cloud Driver: open the site, connect the keyboard and change its keys,
lighting, macros and settings.

**Open it:** https://akko-cloud.pages.dev

## How it works

The site talks to the keyboard directly from your browser through
[WebHID](https://developer.mozilla.org/docs/Web/API/WebHID_API). Nothing is installed and no
server is involved: your changes go from the browser straight to the keyboard over USB.

1. Plug the keyboard into your computer with the **USB cable**, or plug in its **2.4 GHz receiver**.
2. Open the site in **Chrome, Edge, Opera or Brave**.
3. Click **Connect keyboard** and pick the keyboard in the browser's prompt.

No keyboard at hand? Click **Open demo** to try every screen with a simulated keyboard.

### On each operating system

| System | Works? | What to do |
|---|---|---|
| **Windows** | ✅ | Nothing extra. |
| **macOS** | ✅ | Nothing extra. |
| **ChromeOS** | ✅ | Nothing extra. |
| **Linux** | ✅ | Install the permission rule once (below). |
| **Android, iPhone, iPad** | ❌ | Mobile browsers don't support WebHID. |
| **Firefox, Safari** (any OS) | ❌ | These browsers don't support WebHID. Use a Chromium browser. |

**Linux:** by default only the system administrator may open keyboards directly, so the browser shows
*"Failed to open the device"*. Install the rule from this repository once on each Linux PC, then
unplug and replug the keyboard or receiver:

```bash
sudo cp linux/70-akko-keyboard.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

**2.4 GHz receiver:** changes take a little longer than over the cable. On battery, once the
keyboard's lights go off (after 2 minutes without a key press by default) it also stops answering the
receiver until you press a key. The site tells you when that happens.

## Features

- **Keys:** remap any key on 4 profiles and 2 Fn layers to another key, a key combination, a
  media/system action, a mouse action, a macro, or nothing. The knob's turn and press can be remapped
  too.
- **Macros:** record key presses and mouse clicks, edit steps and delays, and play them as Loop,
  Toggle or Press to play. They're kept in a library with folders, import and export. Macros your
  keys already use are found on the keyboard automatically.
- **Lighting:** 24 backlight effects with colour, rainbow, brightness, speed and direction, the LED
  strip, custom per-key colours, and music or screen-colour sync.
- **Settings:** polling rate, debounce, Windows-key lock, WASD/arrow swap, and wireless power saving
  (lights-off and sleep timers).
- **Backup:** save everything to a file and restore it later. Factory reset.
- **Shortcuts:** a searchable list of the keyboard's own Fn shortcuts.

Not supported: firmware updates, Bluetooth configuration, and Akko's online community features.

## Tech stack

| Part | Used |
|---|---|
| App | Plain **HTML, CSS and JavaScript** (ES modules). No framework, no build step. |
| Keyboard connection | **WebHID** feature reports. The protocol was reverse engineered from the official Windows and macOS apps; see [docs/PROTOCOL.md](docs/PROTOCOL.md). |
| Music and screen sync | **Web Audio** (`AudioContext`) and **Screen Capture** (`getDisplayMedia`). |
| Storage | The browser's **localStorage** (macro library, last-read key maps). Nothing leaves your computer. |
| Hosting | **Cloudflare Pages**, serving the static `web/` folder, with security headers in `web/_headers`. |
| Tests | **Node.js** built-in test runner (`npm test`), run on every push by **GitHub Actions**. |

---

Made by Ifty Rahman. Unofficial project, not affiliated with Akko.
