#!/usr/bin/env python3
"""Akko Web Driver server.

Serves the web driver (web/) over HTTP and HTTPS and, optionally, bridges
HID feature reports to Akko PC75B keyboards plugged into this machine via
Linux hidraw. Standard library only, so it runs on a bare DietPi install.

    python3 akko_server.py --web ../web --http-port 8080 --https-port 8443 \
        --cert /etc/akko-web-driver/server.crt --key /etc/akko-web-driver/server.key
"""

from __future__ import annotations

import argparse
import fcntl
import glob
import json
import logging
import mimetypes
import os
import re
import ssl
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

LOG = logging.getLogger("akko")

# (vendor, product) pairs used by the PC75B family (see web/js/models.js)
KNOWN_IDS = {
    (0x3151, 0x4003): "Akko PC75B (yc300)",
    (0x0461, 0x4003): "Akko PC75B (yc200)",
    (0x05AC, 0x024F): "Akko PC75B (Mac mode)",
    (0x25A7, 0x2420): "Akko 2.4 GHz receiver",
}
CONFIG_USAGE_PAGE = 0x01
CONFIG_USAGE = 0x06
REPORT_LEN = 64  # payload bytes; on the wire: report id 0 + 64 bytes


def _ioc(direction: int, nr: int, size: int) -> int:
    return (direction << 30) | (size << 16) | (ord("H") << 8) | nr


def HIDIOCSFEATURE(length: int) -> int:  # noqa: N802 - kernel macro name
    return _ioc(3, 0x06, length)


def HIDIOCGFEATURE(length: int) -> int:  # noqa: N802
    return _ioc(3, 0x07, length)


# ---------------------------------------------------------------- descriptors
def parse_collections(desc: bytes) -> list[dict]:
    """Return top-level collections with their usage and feature-report size."""
    cols: list[dict] = []
    usage_page = 0
    report_size = 0
    report_count = 0
    usages: list[int] = []
    depth = 0
    current = None
    i = 0
    while i < len(desc):
        prefix = desc[i]
        if prefix == 0xFE:  # long item
            if i + 1 >= len(desc):
                break
            i += 3 + desc[i + 1]
            continue
        size = (0, 1, 2, 4)[prefix & 3]
        kind = (prefix >> 2) & 3
        tag = prefix >> 4
        data = int.from_bytes(desc[i + 1 : i + 1 + size], "little")
        i += 1 + size
        if kind == 1:  # global
            if tag == 0:
                usage_page = data
            elif tag == 7:
                report_size = data
            elif tag == 9:
                report_count = data
        elif kind == 2:  # local
            if tag == 0:
                usages.append(data if size == 4 else (usage_page << 16) | data)
        elif kind == 0:  # main
            if tag == 0xA:  # collection
                if depth == 0:
                    u = usages[0] if usages else 0
                    current = {"usage_page": u >> 16, "usage": u & 0xFFFF, "feature_bits": 0}
                    cols.append(current)
                depth += 1
            elif tag == 0xC:  # end collection
                depth = max(0, depth - 1)
            elif tag == 0xB and current is not None:  # feature
                current["feature_bits"] += report_size * report_count
            usages = []
    return cols


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def scan_devices() -> list[dict]:
    found = []
    for node in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        name = os.path.basename(node)
        uevent = _read(os.path.join(node, "device", "uevent"))
        m = re.search(r"HID_ID=\w+:([0-9A-Fa-f]+):([0-9A-Fa-f]+)", uevent)
        if not m:
            continue
        vid, pid = int(m.group(1), 16), int(m.group(2), 16)
        if (vid, pid) not in KNOWN_IDS:
            continue
        try:
            with open(os.path.join(node, "device", "report_descriptor"), "rb") as f:
                cols = parse_collections(f.read())
        except OSError:
            continue
        if not any(
            c["usage_page"] == CONFIG_USAGE_PAGE and c["usage"] == CONFIG_USAGE and c["feature_bits"] >= REPORT_LEN * 8
            for c in cols
        ):
            continue
        hid_name = re.search(r"HID_NAME=(.*)", uevent)
        found.append(
            {
                "id": name,
                "vendorId": vid,
                "productId": pid,
                "name": (hid_name.group(1).strip() if hid_name else "") or KNOWN_IDS[(vid, pid)],
                "path": f"/dev/{name}",
            }
        )
    return found


class HidBridge:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.fds: dict[str, int] = {}

    def _fd(self, dev_id: str) -> int:
        if not re.fullmatch(r"hidraw\d+", dev_id):
            raise PermissionError("invalid device")
        if dev_id not in {d["id"] for d in scan_devices()}:
            raise FileNotFoundError("device not found")
        fd = self.fds.get(dev_id)
        if fd is None:
            fd = os.open(f"/dev/{dev_id}", os.O_RDWR | os.O_CLOEXEC)
            self.fds[dev_id] = fd
        return fd

    def _drop(self, dev_id: str) -> None:
        fd = self.fds.pop(dev_id, None)
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass

    def send(self, dev_id: str, payload: bytes) -> None:
        if len(payload) != REPORT_LEN:
            raise ValueError(f"payload must be {REPORT_LEN} bytes")
        buf = bytearray(b"\x00" + payload)
        with self.lock:
            try:
                fcntl.ioctl(self._fd(dev_id), HIDIOCSFEATURE(len(buf)), buf)
            except OSError:
                self._drop(dev_id)
                raise

    def receive(self, dev_id: str) -> bytes:
        buf = bytearray(REPORT_LEN + 1)
        buf[0] = 0
        with self.lock:
            try:
                n = fcntl.ioctl(self._fd(dev_id), HIDIOCGFEATURE(len(buf)), buf, True)
            except OSError:
                self._drop(dev_id)
                raise
        data = bytes(buf[1 : 1 + REPORT_LEN]) if n is None or n >= 1 else bytes(REPORT_LEN)
        return data.ljust(REPORT_LEN, b"\x00")


# ---------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    server_version = "AkkoWebDriver/1.0"
    bridge: HidBridge | None = None
    web_root = "."

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=self.web_root, **kwargs)

    def log_message(self, fmt, *args):  # route to logging
        LOG.info("%s %s", self.address_string(), fmt % args)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "hid=(self)")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def guess_type(self, path):
        if path.endswith(".js"):
            return "text/javascript"
        return mimetypes.guess_type(path)[0] or "application/octet-stream"

    # -- API helpers
    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is None:
            return True  # same-origin GETs / non-browser clients
        return urlsplit(origin).netloc == self.headers.get("Host")

    def _api(self, method: str) -> None:
        path = urlsplit(self.path).path
        if self.bridge is None:
            return self._json(HTTPStatus.NOT_FOUND, {"error": "bridge disabled"})
        if not self._same_origin():
            return self._json(HTTPStatus.FORBIDDEN, {"error": "cross-origin request refused"})
        if path == "/api/devices" and method == "GET":
            return self._json(HTTPStatus.OK, {"devices": scan_devices()})
        m = re.fullmatch(r"/api/devices/([^/]+)/feature", path)
        if not m:
            return self._json(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})
        dev_id = unquote(m.group(1))
        try:
            if method == "GET":
                return self._json(HTTPStatus.OK, {"data": self.bridge.receive(dev_id).hex()})
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                return self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "expected application/json"})
            length = int(self.headers.get("Content-Length", "0"))
            if length > 4096:
                return self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "too large"})
            body = json.loads(self.rfile.read(length) or b"{}")
            self.bridge.send(dev_id, bytes.fromhex(body.get("data", "")))
            return self._json(HTTPStatus.OK, {"ok": True})
        except FileNotFoundError as e:
            return self._json(HTTPStatus.NOT_FOUND, {"error": str(e)})
        except PermissionError as e:
            return self._json(HTTPStatus.FORBIDDEN, {"error": f"permission denied: {e}. Install the udev rule (see README)."})
        except (ValueError, json.JSONDecodeError) as e:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(e)})
        except OSError as e:
            return self._json(HTTPStatus.BAD_GATEWAY, {"error": f"HID I/O failed: {e.strerror or e}"})

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._api("GET")
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self._api("POST")
        self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)

    def list_directory(self, path):  # never expose directory listings
        self.send_error(HTTPStatus.NOT_FOUND)
        return None


def serve(server: ThreadingHTTPServer, label: str) -> threading.Thread:
    t = threading.Thread(target=server.serve_forever, name=label, daemon=True)
    t.start()
    host, port = server.server_address[:2]
    LOG.info("%s listening on %s:%s", label, host, port)
    return t


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--web", default=os.path.join(here, "..", "web"), help="directory with the web app")
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--http-port", type=int, default=8080, help="0 disables plain HTTP")
    ap.add_argument("--https-port", type=int, default=8443, help="0 disables HTTPS")
    ap.add_argument("--cert", help="TLS certificate (PEM)")
    ap.add_argument("--key", help="TLS private key (PEM)")
    ap.add_argument("--no-bridge", action="store_true", help="do not expose locally attached keyboards")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format="%(asctime)s %(levelname)s %(message)s")

    Handler.web_root = os.path.abspath(args.web)
    Handler.bridge = None if args.no_bridge else HidBridge()
    if not os.path.isfile(os.path.join(Handler.web_root, "index.html")):
        raise SystemExit(f"web root {Handler.web_root} has no index.html")

    threads = []
    if args.http_port:
        threads.append(serve(ThreadingHTTPServer((args.bind, args.http_port), Handler), "http"))
    if args.https_port:
        if not (args.cert and args.key):
            LOG.warning("HTTPS disabled: --cert/--key not given (WebHID needs HTTPS when not on localhost)")
        else:
            httpd = ThreadingHTTPServer((args.bind, args.https_port), Handler)
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.load_cert_chain(args.cert, args.key)
            # handshake lazily in the request thread so a slow client cannot stall accept()
            httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)
            threads.append(serve(httpd, "https"))
    if not threads:
        raise SystemExit("nothing to serve: both ports disabled")
    print(f"Akko Web Driver serving {Handler.web_root} (bridge {'off' if args.no_bridge else 'on'})", flush=True)
    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
