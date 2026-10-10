'use strict';
/**
 * deploy/scripts/deploy.sh is a thin wrapper around `ovhost deploy network --install-units` (OpenVibe.Host,
 * strategy git-checkout). A fake ovhost records what the wrapper asks for.
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
echo "ovhost $*" >> "${log}"
exit "\${FAKE_EXIT:-0}"
`, { mode: 0o755 });

function run(args = [], env = {}) {
    fs.rmSync(log, { force: true });
    const r = spawnSync('bash', [WRAPPER, ...args], { env: { PATH: process.env.PATH, OVHOST: ovhost, OVHOST_SUDO: '', ...env }, encoding: 'utf8' });
    let calls = [];
    try { calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { /* none */ }
    return { code: r.status, out: r.stdout + r.stderr, calls };
}

// The unit file is installed on every deploy.
assert.deepStrictEqual(run().calls, ['ovhost deploy network --install-units']);
assert.deepStrictEqual(run(['--restart']).calls, ['ovhost deploy network --restart --install-units']);
assert.deepStrictEqual(run(['--rollback']).calls, ['ovhost rollback network']);
assert.deepStrictEqual(run([], { DRY_RUN: '1' }).calls, ['ovhost plan network']);
assert.strictEqual(run([], { FAKE_EXIT: '3' }).code, 3, "ovhost's exit code is the wrapper's");
assert.strictEqual(run(['--nope']).code, 1);

const missing = run([], { OVHOST: path.join(tmp, 'missing') });
assert.strictEqual(missing.code, 1);
assert.deepStrictEqual(missing.calls, []);
assert.match(missing.out, /ovhost not found/);
assert.doesNotMatch(fs.readFileSync(WRAPPER, 'utf8'), /deploy-legacy|DEPLOY_LEGACY|OVHOST_LEGACY|capabilities/);
assert.match(fs.readFileSync(WRAPPER, 'utf8'), /^set -euo pipefail$/m);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('deploy wrapper: all checks passed');
