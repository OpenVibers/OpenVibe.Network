#!/usr/bin/env bash
# Snapshot of the OpenVibers GitHub account for the Wave 0 baseline (read-only, via gh).
# Writes docs/roadmap-baseline/data/github.json: every repository plus, for charter-only repos,
# their STATUS.json.
set -euo pipefail
OUT="$(cd "$(dirname "$0")/../.." && pwd)/docs/roadmap-baseline/data/github.json"
mkdir -p "$(dirname "$OUT")"
gh repo list OpenVibers --limit 200 --json name,description,visibility,pushedAt,diskUsage,defaultBranchRef,isArchived \
    > "$OUT.repos"
node - "$OUT.repos" > "$OUT.tmp" <<'NODE'
const { execFileSync } = require('child_process');
const repos = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
for (const r of repos) {
    r.defaultBranch = r.defaultBranchRef ? r.defaultBranchRef.name : null;
    delete r.defaultBranchRef;
    try {
        const raw = execFileSync('gh', ['api', `repos/OpenVibers/${r.name}/contents/STATUS.json`, '-H', 'Accept: application/vnd.github.raw'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        r.status = JSON.parse(raw);
    } catch { r.status = null; }
}
repos.sort((a, b) => a.name.localeCompare(b.name));
process.stdout.write(JSON.stringify({ owner: 'OpenVibers', collectedAt: new Date().toISOString(), repos }, null, 2) + '\n');
NODE
rm -f "$OUT.repos"
mv "$OUT.tmp" "$OUT"
echo "wrote $OUT"
