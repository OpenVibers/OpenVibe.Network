#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# OpenVibe.Network — deploy: a thin wrapper around `ovhost deploy network --install-units`
# (OpenVibe.Host, strategy git-checkout; roadmap WS-N task 11; OpenVibe.Host docs/deploy-strategies.md).
#
#   sudo /opt/openvibe.network/deploy/scripts/deploy.sh               ovhost deploy network --install-units
#   sudo /opt/openvibe.network/deploy/scripts/deploy.sh --restart     … --restart (the old script restarted even
#                                                                     with nothing new; ovhost does only when asked)
#   sudo /opt/openvibe.network/deploy/scripts/deploy.sh --rollback    ovhost rollback network
#   DRY_RUN=1 /opt/openvibe.network/deploy/scripts/deploy.sh          ovhost plan network
#
# ovhost does what this script did, as the checkout owner: pull (fast-forward only), npm install --omit=dev when
# the lockfile or dependency fields changed (then the lockfile is restored), deploy/systemd/openvibe-network.service
# installed when it differs (daemon-reload), restart, /api/ready polled. New: every dependency must resolve before
# the restart, a release that does not come up is rolled back (exit 3), every attempt is in `ovhost releases
# network`, freezes are honoured (exit 6) and the release is announced.
#
# Fallback: deploy-legacy.sh (the previous script, unchanged) when ovhost is missing or too old (no
# `capabilities`, deploy-api < 1), or the host inventory does not manage network; OVHOST_LEGACY=1 forces it.
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

SERVICE=network
STRATEGY=git-checkout
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LEGACY="${DEPLOY_LEGACY:-$HERE/deploy-legacy.sh}"
OVHOST="${OVHOST:-/usr/local/bin/ovhost}"
if [ "${OVHOST_SUDO-auto}" = auto ]; then if [ "$(id -u)" -eq 0 ]; then SUDO=(); else SUDO=(sudo); fi; elif [ -n "${OVHOST_SUDO}" ]; then SUDO=("$OVHOST_SUDO"); else SUDO=(); fi

CMD=deploy
FLAGS=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        --wait-idle|--restart|--force) FLAGS+=("$1"); shift ;;
        --rollback) CMD=rollback; shift ;;
        --) shift; break ;;
        *) echo "Usage: $0 [--restart] [--wait-idle] [--force] [--rollback]   (DRY_RUN=1 for the plan)"; exit 1 ;;
    esac
done

legacy() {
    echo "[Deploy] $1 — running deploy-legacy.sh (the previous deploy script) instead"
    if [ "$CMD" = rollback ] || [ "${DRY_RUN:-0}" = 1 ]; then echo "[Deploy] ✗ deploy-legacy.sh has no --rollback or DRY_RUN; nothing was done" >&2; exit 1; fi
    exec bash "$LEGACY"
}

REASON=""
probe() {
    if [ "${OVHOST_LEGACY:-0}" = 1 ]; then REASON="OVHOST_LEGACY=1"; return 1; fi
    if ! command -v "$OVHOST" >/dev/null 2>&1; then REASON="ovhost not found ($OVHOST)"; return 1; fi
    local caps api
    if ! caps=$("${SUDO[@]}" "$OVHOST" capabilities "$SERVICE" 2>/dev/null); then REASON="this ovhost has no 'capabilities' (too old) or no inventory entry for $SERVICE"; return 1; fi
    api=$(printf '%s\n' "$caps" | sed -n 's/^deploy-api=//p')
    case "$api" in ''|*[!0-9]*) REASON="this ovhost reports no deploy-api (too old)"; return 1 ;; esac
    if [ "$api" -lt 1 ]; then REASON="this ovhost's deploy-api is $api, 1 is needed"; return 1; fi
    if ! printf '%s\n' "$caps" | grep -qx "strategy=$STRATEGY"; then REASON="the host inventory does not deploy $SERVICE with strategy $STRATEGY ($(printf '%s\n' "$caps" | sed -n 's/^strategy=//p'))"; return 1; fi
    if ! printf '%s\n' "$caps" | grep -qx "managed=yes"; then REASON="ovhost does not manage $SERVICE"; return 1; fi
    return 0
}

probe || legacy "$REASON"

if [ "${DRY_RUN:-0}" = 1 ]; then exec "${SUDO[@]}" "$OVHOST" plan "$SERVICE"; fi
[ "$CMD" = deploy ] && FLAGS+=(--install-units)
echo "[Deploy] ovhost $CMD $SERVICE ${FLAGS[*]}"
exec "${SUDO[@]}" "$OVHOST" "$CMD" "$SERVICE" "${FLAGS[@]}"
