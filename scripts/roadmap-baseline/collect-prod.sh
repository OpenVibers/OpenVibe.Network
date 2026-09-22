#!/usr/bin/env bash
# Read-only snapshot of the production host for the Wave 0 baseline.
#
#   scripts/roadmap-baseline/collect-prod.sh [ssh-host]   (default: openvibe-ovh)
#
# Writes docs/roadmap-baseline/data/prod-snapshot.json. What it records, and nothing more:
#   - deployed git SHA per /opt/openvibe.<svc>
#   - openvibe-* systemd unit names and state
#   - every SQLite file under /opt/openvibe.*: size and TABLE NAMES (sqlite3 -readonly; no rows read)
#   - env file names under /etc/openvibe and the variable NAMES they set. Values are stripped by
#     sed on the host before anything leaves it; they are never transferred or printed.
set -euo pipefail
HOST="${1:-openvibe-ovh}"
OUT="$(cd "$(dirname "$0")/../.." && pwd)/docs/roadmap-baseline/data/prod-snapshot.json"
mkdir -p "$(dirname "$OUT")"

ssh -o BatchMode=yes "$HOST" 'bash -s' > "$OUT.tmp" <<'REMOTE'
set -u
node - <<'NODE'
const { execSync } = require('child_process');
const fs = require('fs');
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const deployments = {};
for (const d of fs.readdirSync('/opt').filter(n => n.startsWith('openvibe.'))) {
    const dir = '/opt/' + d;
    deployments[d.slice('openvibe.'.length)] = {
        path: dir,
        sha: sh(`git -C ${dir} rev-parse HEAD`) || null,
        committedAt: sh(`git -C ${dir} log -1 --format=%cI`) || null,
    };
}
const units = sh("systemctl list-units 'openvibe*' --all --no-legend --plain").split('\n').filter(Boolean)
    .map(l => { const [unit, load, active, sub] = l.split(/\s+/); return { unit, load, active, sub }; });
const databases = sh("find /opt/openvibe.* -maxdepth 5 -name '*.db' -not -path '*/node_modules/*'").split('\n').filter(Boolean)
    .map(file => ({
        file,
        bytes: fs.statSync(file).size,
        tables: sh(`sqlite3 -readonly '${file}' "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"`).split('\n').filter(Boolean),
    }));
const envFiles = {};
for (const f of sh('sudo -n ls /etc/openvibe').split('\n').filter(n => n.endsWith('.env'))) {
    envFiles[f] = sh(`sudo -n sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\\2/p' /etc/openvibe/${f}`)
        .split('\n').filter(Boolean).sort();
}
process.stdout.write(JSON.stringify({
    host: sh('hostname'), collectedAt: new Date().toISOString(), deployments, units, databases, envFiles,
}, null, 2) + '\n');
NODE
REMOTE
mv "$OUT.tmp" "$OUT"
echo "wrote $OUT"
