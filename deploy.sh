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
port="${PORT:-4000}"
if curl -fsS -m 10 "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
  echo "==> API is responding on port ${port}. Done."
else
  echo "!! API did not answer on port ${port}. Check the logs:"
  echo "     pm2 logs --lines 50        (if you use pm2)"
  echo "     journalctl -u <service> -n 50 --no-pager   (if you use systemd)"
  exit 1
fi

echo
echo "Deployed commit: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
