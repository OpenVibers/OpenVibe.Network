'use strict';
// server/setup/service-principal.js: create/rotate a service client; the secret lands in the env file (0600),
// never on stdout; existing env lines are kept. The database is the process one (test/helpers/pg-preload.mjs).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDb } = require('../server/db/database');
const config = require('../server/config');
const sp = require('../server/setup/service-principal');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-sp-'));
const db = await getDb();
const env = path.join(dir, 'events.env');
fs.writeFileSync(env, 'PORT=4300\nOV_OAUTH_CLIENT_SECRET=old\n');
const dbArg = config.db.url ? ['--database-name', decodeURIComponent(new URL(config.db.url).pathname.slice(1))] : [];

const out = [];
const errors = [];
const log = console.log; const err = console.error;
console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => errors.push(a.join(' '));
assert.strictEqual(sp.hasScriptEnvFile([], [process.execPath, process.argv[1], '--env-file', env]), true,
    'Node strips a trailing --env-file from argv');
assert.strictEqual(sp.hasScriptEnvFile([], [process.execPath, '--env-file=/etc/openvibe/network.env', process.argv[1], '--write-env', env]), false);
assert.strictEqual(await sp.main(['create', 'events', '--env-file', env]), 2);
assert.match(errors.pop(), /^Use --write-env: Node loads --env-file as environment/);
assert.strictEqual(await sp.main(['create', 'events', `--env-file=${env}`]), 2);
assert.match(errors.pop(), /^Use --write-env: Node loads --env-file as environment/);
assert.strictEqual(fs.readFileSync(env, 'utf8'), 'PORT=4300\nOV_OAUTH_CLIENT_SECRET=old\n');
const originalUrl = config.db.url;
const originalDirectUrl = config.db.directUrl;
config.db.url = 'postgres://localhost/ov_events';
assert.strictEqual(await sp.main(['create', 'events', '--write-env', env]), 2, 'wrong database refused before init');
assert.match(errors.pop(), /^DATABASE_URL must select database ov_network/);
config.db.url = 'postgres://localhost/ov_network';
config.db.directUrl = 'postgres://localhost/ov_events';
assert.strictEqual(await sp.main(['create', 'events', '--write-env', env]), 2, 'wrong migration database refused before init');
assert.match(errors.pop(), /^DATABASE_DIRECT_URL must select database ov_network/);
config.db.url = originalUrl;
config.db.directUrl = originalDirectUrl;
assert.strictEqual(await sp.main(['create', 'events', '--write-env', env, ...dbArg]), 0);
assert.strictEqual(await sp.main(['create', 'events', '--write-env', env, ...dbArg]), 1, 'no double create');
const first = fs.readFileSync(env, 'utf8');
assert.strictEqual(await sp.main(['rotate', 'events', '--write-env', env, ...dbArg]), 0);
console.log = log; console.error = err;
const second = fs.readFileSync(env, 'utf8');
const secretOf = (s) => s.match(/^OV_OAUTH_CLIENT_SECRET=(.+)$/m)[1];
assert.ok(/^PORT=4300$/m.test(second), 'other lines kept');
assert.strictEqual((second.match(/OV_OAUTH_CLIENT_SECRET=/g) || []).length, 1, 'one secret line');
assert.notStrictEqual(secretOf(first), secretOf(second), 'rotate changes the secret');
assert.strictEqual(fs.statSync(env).mode & 0o777, 0o600);
assert.ok(!out.join('\n').includes(secretOf(second)) && !out.join('\n').includes(secretOf(first)), 'secrets are never printed');
const row = await db.prepare("SELECT client_secret, redirect_uris FROM oauth_clients WHERE client_id = 'events'").get();
assert.strictEqual(row.client_secret, secretOf(second));
assert.strictEqual(row.redirect_uris, '[]', 'service principals cannot do user sign-in');
fs.rmSync(dir, { recursive: true, force: true });
console.log('service principal provisioning: all checks passed');
})().catch(err => { console.error(err); process.exit(1); });
