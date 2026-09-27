'use strict';
/**
 * deploy/scripts/deploy.sh is a thin wrapper around `ovhost deploy network --install-units` (OpenVibe.Host,
 * strategy git-checkout; roadmap WS-N task 11) with deploy-legacy.sh (the previous script, unchanged) as
 * its fallback. A fake ovhost records what the wrapper asks for; a fake legacy script records the fallback.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WRAPPER = path.join(__dirname, '..', 'deploy', 'scripts', 'deploy.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'network-deploy-wrapper-'));
const log = path.join(tmp, 'calls.log');
const ovhost = path.join(tmp, 'ovhost');
fs.writeFileSync(ovhost, `#!/usr/bin/env bash
if [ "$1" = capabilities ]; then
  [ -n "$FAKE_OLD" ] && exit 1
  printf '%b\\n' "\${FAKE_CAPS:-ovhost=0.3.0\\ndeploy-api=1\\nservice=network\\nstrategy=git-checkout\\nmanaged=yes\\nlayout=git}"
  exit 0
fi
echo "ovhost $*" >> "${log}"
exit "\${FAKE_EXIT:-0}"
`, { mode: 0o755 });
const legacy = path.join(tmp, 'legacy.sh');
fs.writeFileSync(legacy, `#!/usr/bin/env bash\necho "legacy" >> "${log}"\n`, { mode: 0o755 });

function run(args = [], env = {}) {
    fs.rmSync(log, { force: true });
    const r = spawnSync('bash', [WRAPPER, ...args], { env: { PATH: process.env.PATH, OVHOST: ovhost, OVHOST_SUDO: '', DEPLOY_LEGACY: legacy, ...env }, encoding: 'utf8' });
    let calls = [];
    try { calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { /* none */ }
    return { code: r.status, out: r.stdout + r.stderr, calls };
}

// The unit file is installed on every deploy, as the old script did.
assert.deepStrictEqual(run().calls, ['ovhost deploy network --install-units']);
assert.deepStrictEqual(run(['--restart']).calls, ['ovhost deploy network --restart --install-units']);
assert.deepStrictEqual(run(['--rollback']).calls, ['ovhost rollback network']);
assert.deepStrictEqual(run([], { DRY_RUN: '1' }).calls, ['ovhost plan network']);
assert.strictEqual(run([], { FAKE_EXIT: '3' }).code, 3, "ovhost's exit code is the wrapper's");
assert.strictEqual(run(['--nope']).code, 1);

let r = run([], { FAKE_OLD: '1' });
assert.deepStrictEqual(r.calls, ['legacy']);
assert.match(r.out, /too old/);
r = run([], { FAKE_CAPS: 'deploy-api=1\\nstrategy=git-checkout\\nmanaged=no' });
assert.deepStrictEqual(r.calls, ['legacy']);
assert.match(r.out, /does not manage network/);
assert.deepStrictEqual(run([], { OVHOST: path.join(tmp, 'missing') }).calls, ['legacy']);
assert.strictEqual(run(['--rollback'], { OVHOST_LEGACY: '1' }).code, 1, 'the legacy script has no rollback');
const legacyText = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'scripts', 'deploy-legacy.sh'), 'utf8');
assert.match(legacyText, /git pull "\$GIT_REMOTE" "\$GIT_BRANCH" --ff-only/, 'deploy-legacy.sh is the previous script');
assert.match(fs.readFileSync(WRAPPER, 'utf8'), /^set -euo pipefail$/m);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('deploy wrapper: all checks passed');
