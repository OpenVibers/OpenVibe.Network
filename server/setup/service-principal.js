#!/usr/bin/env node
'use strict';
/**
 * Provision or rotate a service principal's client credentials (roadmap Wave 1, ADR-003).
 *
 *   sudo node server/setup/service-principal.js create <id> --env-file /etc/openvibe/<id>.env [--db data/network.db]
 *   sudo node server/setup/service-principal.js rotate <id> --env-file /etc/openvibe/<id>.env
 *   node server/setup/service-principal.js list
 *
 * A service principal is an OAuth client with no redirect URIs (it can only use client_credentials).
 * The secret is written straight into the service's env file as OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET
 * (file mode 0600) and is never printed. Grants are separate (principal_grants); this only makes the
 * identity exist.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

function upsertEnv(file, pairs) {
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
    const keys = new Set(Object.keys(pairs));
    const kept = lines.filter(l => !keys.has((l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/) || [])[1]));
    while (kept.length && kept[kept.length - 1] === '') kept.pop();
    for (const [k, v] of Object.entries(pairs)) kept.push(`${k}=${v}`);
    fs.writeFileSync(file, kept.join('\n') + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
}

function main(argv) {
    const [cmd, id] = argv;
    const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
    const dbPath = path.resolve(opt('db') || process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'network.db'));
    const db = new Database(dbPath, { fileMustExist: true });
    try {
        if (cmd === 'list') {
            for (const r of db.prepare("SELECT client_id, name, redirect_uris FROM oauth_clients ORDER BY client_id").all()) {
                const kind = JSON.parse(r.redirect_uris || '[]').length ? 'site' : 'service';
                console.log(`${r.client_id}\t${kind}\t${r.name}`);
            }
            return 0;
        }
        if (!['create', 'rotate'].includes(cmd) || !ID_RE.test(id || '')) {
            console.error('usage: service-principal.js create|rotate <id> --env-file <path> | list');
            return 2;
        }
        const envFile = opt('env-file');
        if (!envFile) { console.error('--env-file is required (the secret is written there, never printed)'); return 2; }
        const secret = crypto.randomBytes(32).toString('base64url');
        const existing = db.prepare('SELECT client_id, redirect_uris FROM oauth_clients WHERE client_id = ?').get(id);
        if (cmd === 'create') {
            if (existing) { console.error(`${id} already exists; use rotate`); return 1; }
            db.prepare("INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES (?, ?, ?, '[]', 1)")
                .run(id, secret, `OpenVibe.${id} (service)`);
        } else {
            if (!existing) { console.error(`${id} does not exist; use create`); return 1; }
            db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(secret, id);
        }
        upsertEnv(envFile, { OV_OAUTH_CLIENT_ID: id, OV_OAUTH_CLIENT_SECRET: secret });
        console.log(`${cmd === 'create' ? 'created' : 'rotated'} service principal ${id}; credentials written to ${envFile} (0600). Restart the service to pick them up.`);
        return 0;
    } finally { db.close(); }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, upsertEnv };
