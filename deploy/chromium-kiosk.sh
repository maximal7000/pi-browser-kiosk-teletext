#!/usr/bin/env bash
# Started by cage: waits for the Pi-Anzeige server, then runs Chromium full-screen.
set -euo pipefail

START_URL="${START_URL:-http://127.0.0.1/start}"
BROWSER="$(command -v chromium || command -v chromium-browser)"

# --lang is ignored on Linux; Chromium takes its UI language from the environment.
export LANGUAGE=de
export LANG=de_DE.UTF-8

# The server restores the last page over CDP; it only has to be reachable for the start page.
for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "$START_URL" && break
  sleep 1
done

exec "$BROWSER" \
  --kiosk \
  --ozone-platform=wayland \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --hide-crash-restore-bubble \
  --disable-features=Translate,TranslateUI \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --disk-cache-size=33554432 \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins=http://127.0.0.1:9222 \
  --user-data-dir=/var/lib/pi-anzeige-kiosk/chromium \
  "$START_URL"
