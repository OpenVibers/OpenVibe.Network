#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# OpenVibe.Network — deploy: a thin wrapper around `ovhost deploy network --install-units`
# (OpenVibe.Host, strategy git-checkout).
#
#   sudo /opt/openvibe.network/deploy/scripts/deploy.sh               ovhost deploy network --install-units
#   sudo /opt/openvibe.network/deploy/scripts/deploy.sh --restart     … --restart
#   sudo /opt/openvibe.network/deploy/scripts/deploy.sh --rollback    ovhost rollback network
#   DRY_RUN=1 /opt/openvibe.network/deploy/scripts/deploy.sh          ovhost plan network
#
# ovhost deploys as the checkout owner, installs the unit, restarts, checks /api/ready and
# rolls back a release that does not come up.
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

SERVICE=network
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

if ! command -v "$OVHOST" >/dev/null 2>&1; then
    echo "[Deploy] ovhost not found ($OVHOST); install ovhost before deploying network" >&2
    exit 1
fi

if [ "${DRY_RUN:-0}" = 1 ]; then exec "${SUDO[@]}" "$OVHOST" plan "$SERVICE"; fi
[ "$CMD" = deploy ] && FLAGS+=(--install-units)
echo "[Deploy] ovhost $CMD $SERVICE ${FLAGS[*]}"
exec "${SUDO[@]}" "$OVHOST" "$CMD" "$SERVICE" "${FLAGS[@]}"
