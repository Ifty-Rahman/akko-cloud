#!/usr/bin/env bash
# Install the Akko Web Driver on DietPi / Debian / Raspberry Pi OS.
#
#   sudo ./deploy/install.sh                 # install or upgrade
#   sudo ./deploy/install.sh --http-port 80 --https-port 443
#   sudo ./deploy/install.sh --no-bridge     # serve the app only
#   sudo ./deploy/install.sh --renew-cert    # re-issue the server certificate (e.g. new IP)
#   sudo ./deploy/install.sh --uninstall
set -euo pipefail

PREFIX=/opt/akko-web-driver
CONF=/etc/akko-web-driver
SERVICE=akko-web-driver
SVC_USER=akko
HTTP_PORT=8080
HTTPS_PORT=8443
BIND=0.0.0.0
EXTRA_ARGS=""
RENEW=0
UNINSTALL=0
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() { sed -n '2,9p' "$0"; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --http-port) HTTP_PORT="$2"; shift 2 ;;
    --https-port) HTTPS_PORT="$2"; shift 2 ;;
    --bind) BIND="$2"; shift 2 ;;
    --no-bridge) EXTRA_ARGS="--no-bridge"; shift ;;
    --renew-cert) RENEW=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1"; usage ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo $0)"; exit 1; }

if [ "$UNINSTALL" -eq 1 ]; then
  say "Removing service, udev rule and files"
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE.service" /etc/udev/rules.d/70-akko-keyboard.rules /etc/udev/rules.d/71-akko-web-driver-service.rules "/etc/default/$SERVICE"
  systemctl daemon-reload
  udevadm control --reload-rules || true
  rm -rf "$PREFIX"
  echo "Kept $CONF (certificates) and user '$SVC_USER'. Remove them manually if you no longer need them."
  exit 0
fi

# ------------------------------------------------------------------ packages
need=()
command -v python3 >/dev/null || need+=(python3)
command -v openssl >/dev/null || need+=(openssl)
if [ ${#need[@]} -gt 0 ]; then
  say "Installing ${need[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}"
fi
python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' || { echo "Python 3.8+ required"; exit 1; }

# ------------------------------------------------------------------ user
if ! id "$SVC_USER" >/dev/null 2>&1; then
  say "Creating system user '$SVC_USER'"
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SVC_USER"
fi

# ------------------------------------------------------------------ files
say "Installing files to $PREFIX"
install -d -m 755 "$PREFIX" "$PREFIX/server"
rm -rf "$PREFIX/web"
cp -r "$SRC/web" "$PREFIX/web"
install -m 755 "$SRC/server/akko_server.py" "$PREFIX/server/akko_server.py"
chown -R root:root "$PREFIX"
find "$PREFIX" -type d -exec chmod 755 {} +
find "$PREFIX/web" -type f -exec chmod 644 {} +

# ------------------------------------------------------------------ certificates
local_ips() {
  hostname -I 2>/dev/null || ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1
}

gen_certs() {
  local dir="$1" renew="$2"
  install -d -m 750 "$dir"
  local host; host="$(hostname)"
  if [ ! -f "$dir/ca.key" ]; then
    say "Creating a local certificate authority (valid 10 years)"
    openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
      -subj "/CN=Akko Web Driver local CA ($host)" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
      -keyout "$dir/ca.key" -out "$dir/ca.crt" 2>/dev/null
    chmod 600 "$dir/ca.key"
    renew=1
  fi
  if [ "$renew" -eq 1 ] || [ ! -f "$dir/server.crt" ]; then
    say "Issuing server certificate"
    local san="DNS:$host,DNS:$host.local,DNS:localhost,IP:127.0.0.1"
    local ip
    for ip in $(local_ips); do
      san="$san,IP:$ip"
    done
    local ext; ext="$(mktemp)"
    printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$san" > "$ext"
    openssl req -newkey rsa:2048 -nodes -sha256 -subj "/CN=$host" \
      -keyout "$dir/server.key" -out "$dir/server.csr" 2>/dev/null
    openssl x509 -req -sha256 -days 825 -in "$dir/server.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" \
      -CAcreateserial -extfile "$ext" -out "$dir/server.crt" 2>/dev/null
    rm -f "$ext" "$dir/server.csr"
    echo "    SAN: $san"
  fi
}
gen_certs "$CONF" "$RENEW"
chown root:"$SVC_USER" "$CONF" "$CONF/server.key" "$CONF/server.crt"
chmod 750 "$CONF"
chmod 640 "$CONF/server.key"
chmod 644 "$CONF/server.crt" "$CONF/ca.crt"
# publish the CA certificate so client devices can download and trust it
install -m 644 "$CONF/ca.crt" "$PREFIX/web/akko-ca.crt"

# ------------------------------------------------------------------ udev
say "Installing udev rule"
install -m 644 "$SRC/deploy/70-akko-keyboard.rules" /etc/udev/rules.d/70-akko-keyboard.rules
# service access: same devices, group "$SVC_USER" (generated from the desktop rule)
sed -n 's/^\(#\?KERNEL==.*\), TAG+="uaccess"$/\1, MODE="0660", GROUP="'"$SVC_USER"'"/p' \
  "$SRC/deploy/70-akko-keyboard.rules" > /etc/udev/rules.d/71-akko-web-driver-service.rules
chmod 644 /etc/udev/rules.d/71-akko-web-driver-service.rules
udevadm control --reload-rules
udevadm trigger --subsystem-match=hidraw || true

# ------------------------------------------------------------------ service
say "Installing systemd service"
cat > "/etc/default/$SERVICE" <<EOF
AKKO_BIND=$BIND
AKKO_HTTP_PORT=$HTTP_PORT
AKKO_HTTPS_PORT=$HTTPS_PORT
AKKO_EXTRA_ARGS=$EXTRA_ARGS
EOF
install -m 644 "$SRC/deploy/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
if [ "$HTTP_PORT" -lt 1024 ] || [ "$HTTPS_PORT" -lt 1024 ]; then
  mkdir -p "/etc/systemd/system/$SERVICE.service.d"
  printf '[Service]\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n' \
    > "/etc/systemd/system/$SERVICE.service.d/low-ports.conf"
else
  rm -rf "/etc/systemd/system/$SERVICE.service.d"
fi
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
sleep 1
systemctl --no-pager --lines=0 status "$SERVICE" || { journalctl -u "$SERVICE" --no-pager -n 30; exit 1; }

host="$(hostname)"
first_ip="$(local_ips | tr ' ' '\n' | grep -v : | head -n1)"
cat <<EOF

Akko Web Driver is running.

  HTTPS (WebHID — keyboard plugged into the device you browse from):
      https://${first_ip:-$host}:$HTTPS_PORT/
  HTTP  (mini-PC bridge — keyboard plugged into this mini PC):
      http://${first_ip:-$host}:$HTTP_PORT/

To get a trusted padlock (required for WebHID), install the local CA on each
client once:  http://${first_ip:-$host}:$HTTP_PORT/akko-ca.crt   (see README)
EOF
