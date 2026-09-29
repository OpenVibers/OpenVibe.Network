'use strict';
// server/setup/service-principal.js: create/rotate a service client; the secret lands in the env file (0600),
// never on stdout; existing env lines are kept. The database is the process one (test/helpers/pg-preload.mjs).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDb } = require('../server/db/database');
const sp = require('../server/setup/service-principal');

(async () => {
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-sp-'));
const db = await getDb();
const env = path.join(dir, 'events.env');
fs.writeFileSync(env, 'PORT=4300\nOV_OAUTH_CLIENT_SECRET=old\n');

const out = [];
const log = console.log; const err = console.error;
console.log = (...a) => out.push(a.join(' ')); console.error = () => {};
assert.strictEqual(await sp.main(['create', 'events', '--env-file', env]), 0);
assert.strictEqual(await sp.main(['create', 'events', '--env-file', env]), 1, 'no double create');
const first = fs.readFileSync(env, 'utf8');
assert.strictEqual(await sp.main(['rotate', 'events', '--env-file', env]), 0);
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
