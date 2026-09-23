#!/usr/bin/env bash
# Read-only snapshot of the production host for the Wave 0 baseline.
#
#   scripts/roadmap-baseline/collect-prod.sh [ssh-host]   (default: openvibe-ovh)
#
# Writes docs/roadmap-baseline/data/prod-snapshot.json. What it records, and nothing more:
#   - deployed git SHA per /opt/openvibe.<svc>, and the current release of /opt/openre.stream
#   - openvibe-* and openre-* systemd units and timers, with their state
#   - every SQLite file under /opt/openvibe.*, /opt/openre.stream, /var/lib/openvibe-* and /var/lib/openre:
#     size, owner and TABLE NAMES (sqlite3 -readonly, run as the file's owner; no rows read). The drill
#     and restore scratch directories are skipped.
#   - env file names under /etc/openvibe and the variable NAMES they set. Values are stripped by
#     sed on the host before anything leaves it; they are never transferred or printed.
set -euo pipefail
HOST="${1:-openvibe-ovh}"
OUT="$(cd "$(dirname "$0")/../.." && pwd)/docs/roadmap-baseline/data/prod-snapshot.json"
mkdir -p "$(dirname "$OUT")"

ssh -o BatchMode=yes "$HOST" 'bash -s' > "$OUT.tmp" <<'REMOTE'
set -u
node - <<'NODE'
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
// Some checkouts are root-owned (OpenRe's release layout); -c safe.directory reads them without changing any git config.
const git = (dir, ...args) => run('git', ['-c', `safe.directory=${dir}`, '-C', dir, ...args]);
const deployments = {};
for (const d of fs.readdirSync('/opt').filter(n => n.startsWith('openvibe.')).sort()) {
    const dir = '/opt/' + d;
    deployments[d.slice('openvibe.'.length)] = {
        path: dir,
        sha: git(dir, 'rev-parse', 'HEAD') || null,
        committedAt: git(dir, 'log', '-1', '--format=%cI') || null,
    };
}
// OpenRe.Stream uses the release layout: /opt/openre.stream/current -> releases/<sha prefix>, repo/ is the clone.
if (fs.existsSync('/opt/openre.stream/repo')) {
    const rel = path.basename(sh('readlink -f /opt/openre.stream/current'));
    const sha = rel ? git('/opt/openre.stream/repo', 'rev-parse', '--verify', '-q', `${rel}^{commit}`) : '';
    deployments.openre = {
        path: '/opt/openre.stream', layout: 'release', release: rel || null, sha: sha || null,
        committedAt: sha ? git('/opt/openre.stream/repo', 'log', '-1', '--format=%cI', sha) : null,
    };
}
const units = sh("systemctl list-units 'openvibe*' 'openre*' --all --no-legend --plain").split('\n').filter(Boolean)
    .map(l => { const [unit, load, active, sub] = l.split(/\s+/); return { unit, load, active, sub }; })
    .sort((a, b) => a.unit.localeCompare(b.unit));
const dbFiles = [
    ...sh("find /opt/openvibe.* /opt/openre.stream -maxdepth 5 -name '*.db' -not -path '*/node_modules/*'").split('\n'),
    ...sh("sudo -n find /var/lib/openre /var/lib/openvibe-* -maxdepth 3 -name '*.db' -not -path '/var/lib/openvibe-drills/*' -not -path '/var/lib/openvibe-restore/*'").split('\n'),
].filter(Boolean).sort();
const databases = dbFiles.map(file => {
    const [bytes, owner] = sh(`sudo -n stat -c '%s %U' '${file}'`).split(' ');
    const tables = owner ? run('sudo', ['-n', '-u', owner, 'sqlite3', '-readonly', file,
        "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"]) : '';
    return { file, bytes: Number(bytes) || 0, owner: owner || null, tables: tables.split('\n').filter(Boolean) };
});
const envFiles = {};
for (const f of sh('sudo -n ls /etc/openvibe').split('\n').filter(n => n.endsWith('.env')).sort()) {
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
