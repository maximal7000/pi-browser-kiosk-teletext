#!/usr/bin/env bash
# Installs or updates Pi-Anzeige on Raspberry Pi OS Lite. Safe to run again.
set -euo pipefail

APP_DIR=/opt/pi-anzeige
DATA_DIR=/var/lib/pi-anzeige
KIOSK_DIR=/var/lib/pi-anzeige-kiosk
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n==> %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Bitte mit sudo ausführen: sudo ./deploy/install.sh" >&2
  exit 1
fi

say "Pakete installieren"
apt-get update
apt-get install -y cage rsync curl ca-certificates fonts-dejavu-core
if apt-cache policy chromium | grep -q 'Candidate: [0-9]'; then
  apt-get install -y chromium
else
  apt-get install -y chromium-browser
fi

node_major() { node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
apt_node_major() { apt-cache policy nodejs | sed -nE 's/^ *Candidate: ([0-9]+:)?([0-9]+).*/\2/p'; }
if [[ "$(node_major || echo 0)" -lt 20 ]]; then
  if [[ "$(apt_node_major || echo 0)" -ge 20 ]]; then
    apt-get install -y nodejs npm
  else
    # Debian's npm drags in libnode-dev, which clashes with NodeSource's nodejs; NodeSource ships npm itself.
    say "Node.js 20 aus dem NodeSource-Repository installieren"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
fi
if [[ "$(node_major || echo 0)" -lt 20 ]]; then
  echo "Node.js 20 oder neuer wird benötigt, gefunden: $(node --version 2>/dev/null || echo keins)" >&2
  exit 1
fi

say "Benutzer und Verzeichnisse anlegen"
id -u pi-anzeige >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin pi-anzeige
id -u kiosk >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin kiosk
usermod -aG video,render,input,tty kiosk
install -d -o pi-anzeige -g pi-anzeige -m 0750 "$DATA_DIR"
install -d -o kiosk -g kiosk -m 0750 "$KIOSK_DIR"

say "Anwendung nach $APP_DIR kopieren"
install -d "$APP_DIR"
rsync -a --delete \
  --exclude .git --exclude node_modules --exclude test --exclude docs \
  --exclude .superpowers --exclude .impeccable --exclude data \
  "$REPO_DIR/" "$APP_DIR/"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
chmod +x "$APP_DIR/deploy/chromium-kiosk.sh"

say "Chromium-Einblendungen abschalten"
install -d /etc/chromium/policies/managed
install -m 0644 "$APP_DIR/deploy/chromium-policy.json" /etc/chromium/policies/managed/pi-anzeige.json
if [[ -d /etc/chromium-browser ]]; then
  install -d /etc/chromium-browser/policies/managed
  install -m 0644 "$APP_DIR/deploy/chromium-policy.json" /etc/chromium-browser/policies/managed/pi-anzeige.json
fi

say "Dienste einrichten"
install -m 0644 "$APP_DIR/deploy/pam-kiosk" /etc/pam.d/pi-anzeige-kiosk
install -m 0644 "$APP_DIR/deploy/pi-anzeige.service" /etc/systemd/system/pi-anzeige.service
install -m 0644 "$APP_DIR/deploy/kiosk.service" /etc/systemd/system/pi-anzeige-kiosk.service
systemctl daemon-reload
systemctl disable --now getty@tty1.service || true
systemctl enable pi-anzeige.service pi-anzeige-kiosk.service
systemctl restart pi-anzeige.service
systemctl restart pi-anzeige-kiosk.service

CMDLINE=/boot/firmware/cmdline.txt
[[ -f $CMDLINE ]] || CMDLINE=/boot/cmdline.txt
if [[ -f $CMDLINE ]] && ! grep -q 'consoleblank=0' "$CMDLINE"; then
  say "Bildschirmschoner der Konsole abschalten"
  sed -i '1 s/$/ consoleblank=0/' "$CMDLINE"
fi

say "Fertig. Steuerung: http://$(hostname).local"
