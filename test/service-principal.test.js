'use strict';
// server/setup/service-principal.js: create/rotate a service client; the secret lands in the env file (0600),
// never on stdout; existing env lines are kept.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDb } = require('../server/db/database');
const sp = require('../server/setup/service-principal');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-sp-'));
const dbPath = path.join(dir, 'network.db');
const log = console.log; console.log = () => {}; initDb(dbPath).close(); console.log = log;
const env = path.join(dir, 'events.env');
fs.writeFileSync(env, 'PORT=4300\nOV_OAUTH_CLIENT_SECRET=old\n');

const out = [];
console.log = (...a) => out.push(a.join(' '));
assert.strictEqual(sp.main(['create', 'events', '--env-file', env, '--db', dbPath]), 0);
assert.strictEqual(sp.main(['create', 'events', '--env-file', env, '--db', dbPath]), 1, 'no double create');
const first = fs.readFileSync(env, 'utf8');
assert.strictEqual(sp.main(['rotate', 'events', '--env-file', env, '--db', dbPath]), 0);
console.log = log;
const second = fs.readFileSync(env, 'utf8');
const secretOf = (s) => s.match(/^OV_OAUTH_CLIENT_SECRET=(.+)$/m)[1];
assert.ok(/^PORT=4300$/m.test(second), 'other lines kept');
assert.strictEqual((second.match(/OV_OAUTH_CLIENT_SECRET=/g) || []).length, 1, 'one secret line');
assert.notStrictEqual(secretOf(first), secretOf(second), 'rotate changes the secret');
assert.strictEqual(fs.statSync(env).mode & 0o777, 0o600);
assert.ok(!out.join('\n').includes(secretOf(second)) && !out.join('\n').includes(secretOf(first)), 'secrets are never printed');
const Database = require('better-sqlite3');
const row = new Database(dbPath).prepare("SELECT client_secret, redirect_uris FROM oauth_clients WHERE client_id = 'events'").get();
assert.strictEqual(row.client_secret, secretOf(second));
assert.strictEqual(row.redirect_uris, '[]', 'service principals cannot do user sign-in');
fs.rmSync(dir, { recursive: true, force: true });
console.log('service principal provisioning: all checks passed');
