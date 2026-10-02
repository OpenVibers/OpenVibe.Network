#!/usr/bin/env node
'use strict';
/**
 * Provision or rotate a service principal's client credentials (roadmap Wave 1, ADR-003).
 *
 *   sudo node --env-file=/etc/openvibe/network.env server/setup/service-principal.js create <id> --write-env /etc/openvibe/<id>.env
 *   sudo node --env-file=/etc/openvibe/network.env server/setup/service-principal.js rotate <id> --write-env /etc/openvibe/<id>.env
 *   node --env-file=/etc/openvibe/network.env server/setup/service-principal.js list
 *
 * A service principal is an OAuth client with no redirect URIs (it can only use client_credentials).
 * The secret is written straight into the service's env file as OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET
 * (file mode 0600) and is never printed. Grants are separate (principal_grants); this only makes the
 * identity exist. The database is DATABASE_URL (PostgreSQL); there is no SQLite path (plan T2).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initDb } = require('../db/database');
const config = require('../config');

const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

function hasScriptEnvFile(argv, rawArgs = []) {
    if (argv.some(arg => arg === '--env-file' || arg.startsWith('--env-file='))) return true;
    const script = rawArgs.findIndex(arg => !arg.startsWith('-') && path.resolve(arg) === process.argv[1]);
    return script >= 0 && rawArgs.slice(script + 1).some(arg => arg === '--env-file' || arg.startsWith('--env-file='));
}

function upsertEnv(file, pairs) {
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
    const keys = new Set(Object.keys(pairs));
    const kept = lines.filter(l => !keys.has((l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/) || [])[1]));
    while (kept.length && kept[kept.length - 1] === '') kept.pop();
    for (const [k, v] of Object.entries(pairs)) kept.push(`${k}=${v}`);
    fs.writeFileSync(file, kept.join('\n') + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
}

async function main(argv) {
    const [cmd, id] = argv;
    const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
    // Node consumes --env-file after the script name and removes it from process.argv.
    // /proc/self/cmdline retains the launch order, so we can reject the unsafe form.
    let rawArgs = [];
    try { rawArgs = fs.readFileSync('/proc/self/cmdline', 'utf8').split('\0'); } catch { /* argv still catches direct callers */ }
    if (hasScriptEnvFile(argv, rawArgs)) {
        console.error('Use --write-env: Node loads --env-file as environment and can select the target service database.');
        return 2;
    }
    if (cmd !== 'list' && (!['create', 'rotate'].includes(cmd) || !ID_RE.test(id || ''))) {
        console.error('usage: service-principal.js create|rotate <id> --write-env <path> [--database-name <name>] | list');
        return 2;
    }
    const envFile = opt('write-env');
    if (cmd !== 'list' && (!envFile || envFile.startsWith('--'))) {
        console.error('--write-env is required (the secret is written there, never printed)');
        return 2;
    }
    const databaseName = opt('database-name');
    const expectedName = databaseName || 'ov_network';
    if ((argv.includes('--database-name') && (!databaseName || databaseName.startsWith('--')))
        || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(expectedName)) {
        console.error('--database-name must be a database name');
        return 2;
    }
    // Check both connections before initDb() runs migrations or seeds either database.
    if (config.db.url) {
        for (const [key, url] of [['DATABASE_URL', config.db.url], ['DATABASE_DIRECT_URL', config.db.directUrl]]) {
            let name;
            try { name = decodeURIComponent(new URL(url).pathname.slice(1)); } catch { /* invalid URL */ }
            if (name !== expectedName) {
                console.error(`${key} must select database ${expectedName}; use --database-name only for an intentional override.`);
                return 2;
            }
        }
    }
    const db = await initDb();
    if (config.db.url) {
        const connected = await db.prepare('SELECT current_database() AS name').get();
        if (connected.name !== expectedName) {
            console.error(`Connected database must be ${expectedName}.`);
            return 2;
        }
    }
    {
        if (cmd === 'list') {
            for (const r of await db.prepare("SELECT client_id, name, redirect_uris FROM oauth_clients ORDER BY client_id").all()) {
                const kind = JSON.parse(r.redirect_uris || '[]').length ? 'site' : 'service';
                console.log(`${r.client_id}\t${kind}\t${r.name}`);
            }
            return 0;
        }
        const secret = crypto.randomBytes(32).toString('base64url');
        const existing = await db.prepare('SELECT client_id, redirect_uris FROM oauth_clients WHERE client_id = ?').get(id);
        if (cmd === 'create') {
            if (existing) { console.error(`${id} already exists; use rotate`); return 1; }
            await db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES (?, ?, ?, '[]', 1)")
                .run(id, secret, `OpenVibe.${id} (service)`);
        } else {
            if (!existing) { console.error(`${id} does not exist; use create`); return 1; }
            await db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(secret, id);
        }
        upsertEnv(envFile, { OV_OAUTH_CLIENT_ID: id, OV_OAUTH_CLIENT_SECRET: secret });
        console.log(`${cmd === 'create' ? 'created' : 'rotated'} service principal ${id}; credentials written to ${envFile} (0600). Restart the service to pick them up.`);
        return 0;
    }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });
module.exports = { main, upsertEnv, hasScriptEnvFile };
