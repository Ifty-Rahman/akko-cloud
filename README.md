# Akko Cloud

A browser-based replacement for **Akko Cloud Driver** for the **Akko PC75B Plus / PC75B Plus+** family.
You don't install anything: open the site in a Chromium browser, plug in the keyboard (cable or 2.4 GHz
receiver) and configure it over [WebHID](https://developer.mozilla.org/docs/Web/API/WebHID_API).

| Feature | Supported |
|---|---|
| Key remapping on 4 profiles + 2 Fn layers (keys, combos, media/system, mouse, macros, profile switching, disable), knob press and rotation | ✅ |
| Macros: record from your keyboard, edit steps and delays, 3 playback modes, 20 slots | ✅ |
| Backlight: all 24 effects, brightness, speed, colour / rainbow, direction | ✅ |
| LED strip (models that have one) | ✅ |
| Custom per-key colours (painter) | ✅ |
| Music rhythm and screen-colour sync (streams from the browser) | ✅ |
| Polling rate, debounce, Win-key lock, WASD↔arrows, LED off, power-saving, wireless sleep timers | ✅ |
| Profile switching, factory reset, full backup/restore to a JSON file | ✅ |
| USB cable and 2.4 GHz receiver (with battery level) | ✅ |
| Firmware updates, cloud community/sharing, vendor-helper actions (launch app, mic mute) | ❌ |

The protocol was reverse engineered from the official Windows and macOS apps. See
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Using it

1. Open the site in **Chrome, Edge, Opera or Brave on a desktop OS** (Windows, macOS, Linux, ChromeOS).
   Firefox, Safari and mobile browsers do not support WebHID.
2. Plug the keyboard into that computer by USB cable, or plug its 2.4 GHz receiver in.
3. Click **Connect keyboard** and pick the keyboard in the browser prompt.

Over the receiver every packet waits for the keyboard to confirm delivery, so large uploads (key maps,
macros, per-key colours) are slower than over the cable. A sleeping keyboard cannot be reached
wirelessly; when the page says it is asleep, press any key on it.

Without a keyboard, use **Open demo** (or add `?demo` to the URL) to explore every screen with a
simulated device.

### Linux

Linux lets only root open `/dev/hidraw*`, so Chrome shows **"Failed to open the device"** until you
install the udev rule once on each Linux PC you browse from:

```bash
sudo cp linux/70-akko-keyboard.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Then unplug and replug the keyboard (or receiver). The rule grants access to the logged-in desktop
user only.

## Hosting (Cloudflare Pages)

The site is fully static: everything is in `web/`, with no build step and no server code.

Connect the repository once in the Cloudflare dashboard:
**Workers & Pages → Create → Pages → Connect to Git →** pick `akko-cloud`, then:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Framework preset | None |
| Build command | *(leave empty)* |
| Build output directory | `web` |

After that:

* every merge to `main` deploys to production (`https://akko-cloud.pages.dev`),
* every pull request or branch gets its own **preview URL** to test the change before merging.

`web/_headers` sets the security headers, including a strict Content-Security-Policy and
`Permissions-Policy: hid=(self)`. It also disables caching of the app code, so a new deploy shows up
on the next reload.

## Development workflow

```
main  ←  PR  ←  feature/<name> | fix/<name> | chore/<name>
```

1. Branch off `main`: `git switch -c fix/short-description`.
2. Make the change, then run the checks:
   ```bash
   npm test          # protocol / codec tests (Node 20+)
   npm run check     # syntax check of web/js
   npm run dev       # http://localhost:8000 (localhost counts as secure for WebHID)
   ```
3. Push and open a pull request. GitHub Actions runs the tests, and Cloudflare posts a preview URL.
4. Test on the preview with a real keyboard, then merge. Production deploys automatically.

## Layout

```
web/                  static site published by Cloudflare Pages
  index.html, css/    UI
  js/protocol.js      packet builders / Keyboard class (incl. 2.4 GHz receiver handshake)
  js/codec.js         key-action and macro encoders
  js/models.js        device ids, default matrices, physical layout, effect lists
  js/transports.js    WebHID and demo transports
  js/host-effects.js  music rhythm / screen colour streaming
  _headers            HTTP headers for Cloudflare Pages
linux/                udev rule for Linux desktops
docs/PROTOCOL.md      reverse-engineered protocol
tests/                Node tests (npm test)
wrangler.toml         Cloudflare Pages config
```

## Disclaimer

This is an unofficial, independent project. It is not affiliated with Akko. Use it at your own risk.
A factory reset from the Settings tab restores the keyboard defaults.
