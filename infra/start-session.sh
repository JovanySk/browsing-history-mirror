#!/usr/bin/env bash
set -euo pipefail
PROFILE_DIR=/var/lib/historial-espejo/chrome-profile
# Browser executable and the ID Chrome assigns to the unpacked extension (chrome://extensions).
BROWSER_BIN="${BROWSER_BIN:-chromium}"
EXTENSION_ID="${EXTENSION_ID:?set EXTENSION_ID to the unpacked extension ID}"
RUNTIME_DIR=/var/lib/historial-espejo/runtime
export DISPLAY=:99
export XDG_RUNTIME_DIR="$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"
cleanup(){ trap - EXIT INT TERM; local children; children=$(jobs -pr); if [ -n "$children" ]; then kill $children 2>/dev/null || true; fi; }
trap cleanup EXIT
trap 'exit 0' INT TERM
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
xvfb_pid=$!
sleep 1
kill -0 "$xvfb_pid"
openbox-session >/var/log/historial-espejo-openbox.log 2>&1 &
openbox_pid=$!
dbus-run-session -- "$BROWSER_BIN" --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
  --user-data-dir="$PROFILE_DIR" --no-sandbox --disable-dev-shm-usage \
  --no-first-run --window-size=1440,900 \
  "chrome-extension://$EXTENSION_ID/collector.html" \
  >/var/log/historial-espejo-chrome.log 2>&1 &
chrome_pid=$!
wait -n "$xvfb_pid" "$openbox_pid" "$chrome_pid"
