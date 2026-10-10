"""Run: python3 -m unittest discover -s tests"""

import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))

import akko_server  # noqa: E402

# Keyboard collection (page 1 / usage 6) with a 64-byte vendor feature report,
# followed by a consumer-control collection without feature reports.
KEYBOARD_WITH_FEATURE = bytes.fromhex(
    "05010906a101"  # usage page 1, usage 6, collection(application)
    "050719e029e7150025017501950881 02"  # modifiers input
    "0600ff0901150026ff0075089540b102"  # vendor page, report size 8, count 64, feature
    "c0"
    "050c0901a101150026ff0375109501 8100c0"
)
MOUSE_ONLY = bytes.fromhex("05010902a1010901a10005091901290315002501950375018102c0c0")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class DescriptorTests(unittest.TestCase):
    def test_keyboard_feature_collection(self):
        cols = akko_server.parse_collections(KEYBOARD_WITH_FEATURE)
        self.assertEqual(cols[0]["usage_page"], 1)
        self.assertEqual(cols[0]["usage"], 6)
        self.assertEqual(cols[0]["feature_bits"], 64 * 8)
        self.assertEqual(cols[1]["usage_page"], 0x0C)
        self.assertEqual(cols[1]["feature_bits"], 0)

    def test_mouse_has_no_feature(self):
        cols = akko_server.parse_collections(MOUSE_ONLY)
        self.assertEqual((cols[0]["usage_page"], cols[0]["usage"], cols[0]["feature_bits"]), (1, 2, 0))

    def test_ioctl_numbers_match_kernel(self):
        # values of HIDIOCSFEATURE(65) / HIDIOCGFEATURE(65) from <linux/hidraw.h>
        self.assertEqual(akko_server.HIDIOCSFEATURE(65), 0xC0414806)
        self.assertEqual(akko_server.HIDIOCGFEATURE(65), 0xC0414807)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cert, key = os.path.join(cls.tmp.name, "c.pem"), os.path.join(cls.tmp.name, "k.pem")
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
             "-days", "1", "-subj", "/CN=localhost"],
            check=True, capture_output=True,
        )
        cls.http, cls.https = free_port(), free_port()
        cls.proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "server", "akko_server.py"), "--bind", "127.0.0.1",
             "--http-port", str(cls.http), "--https-port", str(cls.https), "--cert", cert, "--key", key],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.http}/", timeout=1)
                break
            except OSError:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)
        cls.proc.stdout.close()
        cls.proc.stderr.close()
        cls.tmp.cleanup()

    def get(self, path, headers=None, https=False):
        url = f"{'https' if https else 'http'}://127.0.0.1:{self.https if https else self.http}{path}"
        ctx = ssl._create_unverified_context() if https else None
        req = urllib.request.Request(url, headers=headers or {})
        return urllib.request.urlopen(req, timeout=5, context=ctx)

    def test_serves_app_over_http_and_https(self):
        for https in (False, True):
            r = self.get("/", https=https)
            self.assertIn(b"Akko Web Driver", r.read())
            self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
        js = self.get("/js/app.js")
        self.assertEqual(js.headers["Content-Type"], "text/javascript")

    def test_no_directory_listing_or_traversal(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.get("/js/")
        self.assertEqual(e.exception.code, 404)
        with self.assertRaises(urllib.error.HTTPError):
            self.get("/../server/akko_server.py")

    def test_device_list(self):
        body = json.loads(self.get("/api/devices").read())
        self.assertIsInstance(body["devices"], list)

    def test_cross_origin_refused(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.get("/api/devices", headers={"Origin": "http://evil.example"})
        self.assertEqual(e.exception.code, 403)

    def test_rejects_unknown_device_and_bad_content_type(self):
        url = f"http://127.0.0.1:{self.http}/api/devices/hidraw999/feature"
        req = urllib.request.Request(url, data=b'{"data":""}', headers={"Content-Type": "text/plain"}, method="POST")
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(e.exception.code, 415)
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.get("/api/devices/hidraw999/feature")
        self.assertEqual(e.exception.code, 404)
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.get("/api/devices/..%2f..%2fetc/feature")
        self.assertEqual(e.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
