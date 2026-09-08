#!/usr/bin/env bash
# Deploy the latest backend code on the server.
#
#   cd ~/oh-sheet-backend-2.0 && git pull && bash deploy.sh
#
# Pulls the newest code, installs anything new, and restarts the running
# API however it happens to be run on this machine (pm2, systemd, or a
# plain node process). Safe to run repeatedly.
set -euo pipefail

cd "$(dirname "$0")"
echo "==> Folder: $(pwd)"

echo "==> Pulling latest code..."
git pull --ff-only

echo "==> Installing dependencies..."
npm install --omit=dev --no-audit --no-fund

if [ -d prisma ]; then
  echo "==> Regenerating Prisma client..."
  npx prisma generate >/dev/null
fi

echo "==> Restarting the API..."
restarted=""

# 1) pm2 — the most common setup.
if command -v pm2 >/dev/null 2>&1 && pm2 pid >/dev/null 2>&1; then
  if pm2 restart all --update-env >/dev/null 2>&1; then
    restarted="pm2"
  fi
fi

# 2) systemd — look for a unit that mentions this app.
if [ -z "$restarted" ] && command -v systemctl >/dev/null 2>&1; then
  unit="$(systemctl list-units --type=service --no-legend --no-pager 2>/dev/null \
    | awk '{print $1}' | grep -iE 'sheet|ohsheet|api' | head -1 || true)"
  if [ -n "$unit" ]; then
    sudo systemctl restart "$unit" && restarted="systemd ($unit)"
  fi
fi

if [ -n "$restarted" ]; then
  echo "==> Restarted via $restarted"
else
  echo "!! Couldn't work out how this server runs the API."
  echo "   Restart it yourself, then re-run this script. Useful checks:"
  echo "     pm2 list"
  echo "     systemctl list-units --type=service | grep -i sheet"
  echo "     ps aux | grep 'node src/server.js' | grep -v grep"
  exit 1
fi

echo "==> Waiting for it to come back up..."
sleep 3

# Which port the API listens on: PORT in the environment, else PORT in
# .env, else the app's own default. Don't guess a single number — a
# wrong guess looks like a failed deploy when the app is fine.
env_port=""
if [ -f .env ]; then
  env_port="$(grep -E '^[[:space:]]*PORT=' .env | tail -1 | cut -d= -f2- \
    | tr -d '"' | tr -d "'" | tr -d '\r' | xargs || true)"
fi

up=""
for port in "${PORT:-}" "$env_port" 5000 4000 3000; do
  [ -n "$port" ] || continue
  if curl -fsS -m 10 "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
    up="$port"
    break
  fi
done

if [ -n "$up" ]; then
  echo "==> API is responding on port ${up}. Done."
else
  echo "!! Couldn't reach the API on any of the usual ports."
  echo "   It may still be fine — check https://api.ohsheet.blog/ in a browser."
  echo "   If that's down too, read the logs:"
  echo "     pm2 logs --lines 50        (if you use pm2)"
  echo "     journalctl -u <service> -n 50 --no-pager   (if you use systemd)"
  exit 1
fi

echo
echo "Deployed commit: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
