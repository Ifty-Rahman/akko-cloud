# Akko Web Driver

A browser-based replacement for **Akko Cloud Driver** for the **Akko PC75B Plus / PC75B Plus+** family. It is
self-hosted on a mini PC (DietPi / Debian) and usable from any device on your network.

| Feature | Supported |
|---|---|
| Key remapping on 4 profiles + 2 Fn layers (keys, combos, media/system, mouse, macros, profile switching, disable), knob press and rotation | ✅ |
| Macros: record from your keyboard, edit steps and delays, 3 playback modes, 20 slots | ✅ |
| Backlight: all 24 effects, brightness, speed, colour / rainbow, direction | ✅ |
| Logo light (models that have one) | ✅ |
| Custom per-key colours (painter) | ✅ |
| Music rhythm and screen-colour sync (streams from the browser) | ✅ |
| Polling rate, debounce, Win-key lock, WASD↔arrows, LED off, power-saving, wireless sleep timers | ✅ |
| Profile switching, factory reset, full backup/restore to a JSON file | ✅ |
| Firmware updates, cloud community/sharing, vendor-helper actions (launch app, mic mute) | ❌ not implemented |

The protocol was reverse engineered from the official Windows and macOS apps. See
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Two ways to connect

| Keyboard plugged into… | Open | Works in |
|---|---|---|
| **the device you browse from** (laptop/desktop) | `https://<mini-pc>:8443/` → *Connect keyboard* | Chrome, Edge, Opera, Brave (desktop) via WebHID |
| **the mini PC** | `http://<mini-pc>:8080/` (or https) → *Find keyboards* | any browser, including phones and tablets |

WebHID only runs on **secure pages** (HTTPS or `localhost`), so the installer
creates a small private certificate authority. Trust it once on each client
(see below). The mini-PC bridge mode works over plain HTTP.

The 2.4 GHz receiver works too, including battery level. A USB cable is faster
for large uploads such as key maps, macros and per-key colours, because every
wireless packet waits for the receiver to confirm delivery.

## Install on the mini PC (DietPi)

```bash
# copy this folder to the mini PC, e.g.
scp -r akko-web-driver dietpi@<mini-pc>:~
ssh dietpi@<mini-pc>
cd akko-web-driver
sudo ./deploy/install.sh
```

The installer:

* installs `python3` and `openssl` if they are missing (the server uses the
  Python standard library only, so there is no pip/npm),
* copies the app to `/opt/akko-web-driver`,
* creates a local CA and server certificate in `/etc/akko-web-driver`,
* installs a udev rule so the service user `akko` can reach the keyboard,
* starts the systemd service `akko-web-driver` on ports 8080 (HTTP) and 8443 (HTTPS).

Options: `--http-port`, `--https-port`, `--bind`, `--no-bridge` (serve the app
only), `--renew-cert` (after the mini PC's IP or hostname changes), and `--uninstall`.

```bash
systemctl status akko-web-driver      # health
journalctl -u akko-web-driver -f      # logs
```

### Trust the certificate on your devices (one time)

Download `http://<mini-pc>:8080/akko-ca.crt` on each client and install it:

* **Windows**: double-click → *Install Certificate* → *Local Machine* → *Trusted Root Certification Authorities*.
* **macOS**: open it in Keychain Access → *System* → set *Always Trust*.
* **Linux (Chrome)**: *Settings → Privacy and security → Security → Manage certificates → Authorities → Import*.
* **Android / iOS**: install it as a CA certificate in the system settings. Phones still cannot use WebHID, so use the bridge mode instead.

Clicking through the browser's certificate warning may work too (not verified on
every browser), but trusting the CA avoids the warning and is the reliable option.

### Linux desktops using WebHID

Linux makes `/dev/hidraw*` readable by root only, so Chrome reports **"Failed to
open the device"** until you install the rule on the Linux PC you browse from:

```bash
sudo cp deploy/70-akko-keyboard.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Then unplug and replug the keyboard (or its receiver) and click *Connect keyboard*
again. The rule grants access to the logged-in user only. On the mini PC the
installer adds a second rule for the service account.

## Try it without hardware

Open `/?demo` (or press *Open demo*). A simulated keyboard implements the same
protocol, so every screen works and nothing touches real hardware.

## Run locally for development

```bash
python3 server/akko_server.py --http-port 8080 --https-port 0 -v   # http://localhost:8080 (localhost counts as secure)
node --test tests/                                                 # protocol tests
python3 -m unittest discover -s tests                              # server tests
```

## Security notes

* The bridge exposes only keyboards with the PC75B USB ids, and only
  feature-report reads and writes. Requests from other websites are refused
  (Origin check plus a JSON-only POST).
* Anyone on your LAN who can open the page can reconfigure a keyboard that is
  plugged into the mini PC. Use `--bind 127.0.0.1` or `--no-bridge`, or
  firewall the ports, if that matters to you.
* The service runs as an unprivileged user under systemd sandboxing, and it can
  only open `hidraw` devices.

## Layout

```
web/                 static app (no build step)
  js/protocol.js     packet builders / Keyboard class
  js/codec.js        key-action and macro encoders
  js/models.js       device ids, default matrices, physical layout, effect lists
  js/transports.js   WebHID, mini-PC bridge, demo
  js/host-effects.js music rhythm / screen colour streaming
server/akko_server.py  HTTP(S) server + hidraw bridge (stdlib only)
deploy/              install.sh, systemd unit, udev rule
docs/PROTOCOL.md     reverse-engineered protocol
tests/               node + python tests
```
