#!/bin/bash
# Keeps the PathFinder backend alive: restarts the Baseten proxy (8787) and
# Metro (8082) if either stops responding. Run: bash server/watchdog.sh &
cd "$(dirname "$0")/.." || exit 1
export TEC_NPM_BIN_DIR="${TEC_NPM_BIN_DIR:-/nix/store/m3wj2l4bir43rj1swgjic7k6w8ppjm97-nodejs-24.15.0/bin}"

while true; do
  if ! curl -sf -m 3 http://localhost:8787/health > /dev/null; then
    echo "[watchdog] $(date '+%H:%M:%S') proxy down — restarting"
    pkill -f "node server/index.mjs" 2>/dev/null
    sleep 1
    nohup node server/index.mjs >> /tmp/pf-proxy.log 2>&1 &
  fi
  if ! curl -sf -m 3 http://localhost:8082/status > /dev/null; then
    echo "[watchdog] $(date '+%H:%M:%S') metro down — restarting"
    pkill -f "expo start" 2>/dev/null
    sleep 1
    nohup npx expo start --dev-client --port 8082 >> /tmp/pf-metro.log 2>&1 &
  fi
  sleep 5
done
