#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# OpenVibe.Network — Deploy Script
# Pulls latest from GitHub, updates the systemd service unit, and restarts the service.
#
# Usage (from the server):
#   sudo /opt/openvibe.network/deploy/scripts/deploy.sh
#
# Or remotely:
#   ssh openvibe.network "sudo /opt/openvibe.network/deploy/scripts/deploy.sh"
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/openvibe.network}"
SERVICE="${SERVICE:-openvibe-network}"
SERVICE_UNIT_SOURCE="${SERVICE_UNIT_SOURCE:-$REPO_DIR/deploy/systemd/${SERVICE}.service}"
SERVICE_UNIT_DEST="${SERVICE_UNIT_DEST:-/etc/systemd/system/${SERVICE}.service}"
SITE_URL="${SITE_URL:-https://openvibe.network}"
API_URL="${API_URL:-http://127.0.0.1:4000}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-main}"
HEALTH_PATH="${HEALTH_PATH:-/api/health}"
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-15}"

cd "$REPO_DIR"

echo "╔══════════════════════════════════════╗"
echo "║      OpenVibe.Network Deploy Script      ║"
echo "╚══════════════════════════════════════╝"
echo ""

# 1. Record current commit before pull
OLD_HASH=$(git rev-parse HEAD 2>/dev/null || echo "none")
echo "[Deploy] Current commit: ${OLD_HASH:0:8}"

# 2. Pull latest from GitHub
echo "[Deploy] Pulling from ${GIT_REMOTE} ${GIT_BRANCH}..."
git pull "$GIT_REMOTE" "$GIT_BRANCH" --ff-only
NEW_HASH=$(git rev-parse HEAD)
echo "[Deploy] New commit: ${NEW_HASH:0:8}"

# 3. Update systemd service config if the repo includes one
UNIT_UPDATED=false
if [ -f "$SERVICE_UNIT_SOURCE" ]; then
    echo "[Deploy] Found service unit source: ${SERVICE_UNIT_SOURCE}"
    if [ ! -f "$SERVICE_UNIT_DEST" ] || ! cmp -s "$SERVICE_UNIT_SOURCE" "$SERVICE_UNIT_DEST"; then
        echo "[Deploy] Installing updated service unit to ${SERVICE_UNIT_DEST}"
        sudo cp "$SERVICE_UNIT_SOURCE" "$SERVICE_UNIT_DEST"
        sudo chmod 644 "$SERVICE_UNIT_DEST"
        UNIT_UPDATED=true
    else
        echo "[Deploy] Service unit is already up to date."
    fi
    if [ "$UNIT_UPDATED" = true ]; then
        echo "[Deploy] Reloading systemd daemon..."
        sudo systemctl daemon-reload
        sudo systemctl enable "$SERVICE" >/dev/null 2>&1 || true
    fi
else
    echo "[Deploy] No service unit file found at ${SERVICE_UNIT_SOURCE}, skipping systemd update."
fi

# 4. Check if there are actually new commits
if [ "$OLD_HASH" = "$NEW_HASH" ]; then
    echo "[Deploy] Already up to date — no new commits."
    echo "[Deploy] Restarting service anyway..."
    sudo systemctl restart "$SERVICE"
    echo "[Deploy] Done. ✅"
    exit 0
fi

# 5. Get commit log between old and new
COMMIT_LOG=$(git --no-pager log --oneline "${OLD_HASH}..${NEW_HASH}" 2>/dev/null || echo "Update deployed")
COMMIT_COUNT=$(echo "$COMMIT_LOG" | wc -l | tr -d ' ')
echo "[Deploy] ${COMMIT_COUNT} new commit(s):"
echo "$COMMIT_LOG"
echo ""

# 6. Restart the service
echo "[Deploy] Restarting ${SERVICE}..."
sudo systemctl restart "$SERVICE"

# 7. Wait for service to come back up
if [ "$COMMIT_COUNT" -gt 0 ]; then
    echo -n "[Deploy] Waiting for server..."
    for i in $(seq 1 "${DEPLOY_TIMEOUT}"); do
        sleep 1
        if curl -sf "${API_URL}${HEALTH_PATH}" > /dev/null 2>&1; then
            echo " up! ✅"
            break
        fi
        echo -n "."
    done
fi

echo ""
echo "[Deploy] Deployment complete! 🎉"
echo "[Deploy] ${COMMIT_COUNT} commit(s) deployed: ${OLD_HASH:0:8} → ${NEW_HASH:0:8}"
