#!/usr/bin/env node
/**
 * Provider secrets out of network.db (roadmap §18.2(12); server/secrets.js). Network reads each secret
 * from its environment variable first and from site_settings only as a fallback; this script is how the
 * operator empties the database copies once the environment has them. It prints setting and variable
 * NAMES, never a value (values are compared by SHA-256 only).
 *
 *   sudo node scripts/secrets-out-of-db.js
 *       dry run: every secret setting by name, whether network.db holds a value, its variable, whether
 *       the env file sets it (and to the same value), and whether the running service has it
 *   sudo node scripts/secrets-out-of-db.js --copy-to-env [--apply]
 *       for each secret the database holds and the env file does not set, append VAR=value to the env
 *       file (after copying it to <env file>.bak-<time>, same mode), so the values move without anyone
 *       seeing them: the database is read by a child process running as its owner and the values go to
 *       the file through a pipe, never to the terminal. Dry run without --apply. Restart the service after.
 *   sudo node scripts/secrets-out-of-db.js --apply --backup <new file> [--allow-different]
 *       takes an online backup (0600, verified), then blanks the database copy of
 *         - each secret whose variable the env file sets to the same value (a different value only with
 *           --allow-different) AND the running service already has (restart it after editing the file)
 *         - each secret setting Network never reads (Net tools tokens, old SES keys)
 *       and leaves every other one as it is, saying why
 *   sudo node scripts/secrets-out-of-db.js --restore-from <backup> [--apply]
 *       rollback: puts the backed-up value back into each secret setting that is blank now
 *
 *   --env-file <path>     default /etc/openvibe/network.env
 *   --db <path>           default $DB_PATH, else data/network.db (relative to the repo root)
 *   --unit <name>         systemd unit whose running process must already have the variables
 *                         (default openvibe-network); --no-service-check skips that check
 *
 * Run with sudo: the env file and the service's environment are root-only. The script reads them, then
 * becomes the database's owner before opening network.db, so no file changes owner.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const ops = require('./lib/db-ops');
const secrets = require('../server/secrets');
const { isSensitiveSettingKey } = require('../server/auth/owner-guard');

const USAGE = `usage: sudo node scripts/secrets-out-of-db.js [--env-file <path>] [--db <path>] [--unit <name> | --no-service-check]
       sudo node scripts/secrets-out-of-db.js --copy-to-env [--apply]
       sudo node scripts/secrets-out-of-db.js --apply --backup <new file> [--allow-different]
       sudo node scripts/secrets-out-of-db.js --restore-from <backup> [--apply]`;

// Settings that look sensitive by name but are not secrets.
const NOT_SECRET = new Set(['discord_oauth_client_id', 'vapid_public_key', 'vapid_contact_email']);

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

function parseEnvText(text) {
    const util = require('util');
    if (typeof util.parseEnv === 'function') return util.parseEnv(text);
    const out = {};
    for (const line of String(text).split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
        if (!m) continue;
        let v = (m[2] || '').trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        out[m[1]] = v;
    }
    return out;
}

function readEnvFile(file) {
    try { return { vars: parseEnvText(fs.readFileSync(file, 'utf8')) }; } catch (err) { return { error: err.code || err.message }; }
}

/** The running unit's environment (root only): { vars } or { error }. */
function serviceEnv(unit) {
    let pid;
    try { pid = execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', unit], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim(); } catch { return { error: 'systemctl unavailable' }; }
    if (!pid || pid === '0') return { error: `${unit} is not running` };
    try {
        const vars = {};
        for (const kv of fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0')) { const i = kv.indexOf('='); if (i > 0) vars[kv.slice(0, i)] = kv.slice(i + 1); }
        return { vars, pid };
    } catch (err) { return { error: `cannot read the environment of pid ${pid} (${err.code || err.message}); run with sudo` }; }
}

/** Every secret-looking setting, classified. */
function classify(db) {
    const rows = db.prepare('SELECT key, value, type FROM site_settings').all();
    const byKey = new Map(rows.map(r => [r.key, r]));
    const out = [];
    for (const s of secrets.SECRETS) out.push({ key: s.key, kind: 'provider', env: s.env, value: (byKey.get(s.key) || {}).value || '' });
    for (const [key, note] of secrets.UNUSED) if (byKey.has(key)) out.push({ key, kind: 'unused', note, value: byKey.get(key).value || '' });
    for (const r of rows) {
        if (out.some(o => o.key === r.key) || NOT_SECRET.has(r.key) || secrets.isManaged(r.key)) continue;
        if (r.type === 'secret' || isSensitiveSettingKey(r.key)) out.push({ key: r.key, kind: 'unclassified', value: r.value || '' });
    }
    return out;
}

// A value systemd's EnvironmentFile and util.parseEnv read back unchanged without quoting.
const PLAIN_VALUE = /^[A-Za-z0-9._\-+/=:~]+$/;

/** Child side of --copy-to-env: the provider values as JSON on stdout (a pipe to the parent only). */
function emitValues(file) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
        const get = db.prepare('SELECT value FROM site_settings WHERE key = ?');
        const out = {};
        for (const s of secrets.SECRETS) { const r = get.get(s.key); if (r && r.value) out[s.env] = String(r.value); }
        process.stdout.write(JSON.stringify(out));
    } finally { db.close(); }
}

/** The database's provider values, read by a child process running as the database owner. */
function readValuesAsOwner(file) {
    const st = fs.statSync(file);
    const asOwner = typeof process.getuid === 'function' && process.getuid() === 0 && st.uid !== 0 ? { uid: st.uid, gid: st.gid } : {};
    const res = require('child_process').spawnSync(process.execPath, [__filename, '--db', file], {
        ...asOwner, env: { PATH: process.env.PATH, OV_SECRETS_EMIT: '1' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1 << 20,
    });
    if (res.status !== 0) throw new Error(`reading the database failed: ${String(res.stderr || '').trim().split('\n').pop()}`);
    return JSON.parse(String(res.stdout));
}

function copyToEnv(file, envFile, envf, apply, log, now = new Date()) {
    if (envf.error) { log(`error: the env file ${envFile} is unreadable (${envf.error}); run with sudo`); return 2; }
    const values = readValuesAsOwner(file);
    const add = [];
    for (const s of secrets.SECRETS) {
        const v = values[s.env];
        if (!v) { log(`  ${s.env}: the database holds no ${s.key}; nothing to copy`); continue; }
        const have = envf.vars[s.env] && String(envf.vars[s.env]).trim();
        if (have) { log(`  ${s.env}: already in the env file (${digest(have) === digest(v) ? 'same value' : 'DIFFERENT value, left as it is'})`); continue; }
        if (!PLAIN_VALUE.test(v)) { log(`  ${s.env}: the value has characters that would need quoting; add it by hand`); continue; }
        add.push([s.env, v]);
        log(`  ${s.env}: ${apply ? 'appended' : 'would be appended'} (from ${s.key})`);
    }
    if (!apply) { log(`dry run: ${add.length} variable(s) to append. Re-run with --copy-to-env --apply.`); return 0; }
    if (!add.length) { log('nothing to append.'); return 0; }
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const bak = `${envFile}.bak-${stamp}`;
    fs.copyFileSync(envFile, bak, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(bak, fs.statSync(envFile).mode & 0o777);
    const text = fs.readFileSync(envFile, 'utf8');
    fs.appendFileSync(envFile, `${text.endsWith('\n') || !text ? '' : '\n'}# Provider secrets moved from network.db site_settings (scripts/secrets-out-of-db.js, ${now.toISOString()})\n${add.map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
    log(`env file   ${envFile}: appended ${add.map(([k]) => k).join(', ')} (previous version: ${bak}). Restart openvibe-network, then run --apply --backup <new file>.`);
    return 0;
}

async function main(argv, log = console.log, { readService = serviceEnv } = {}) {
    let args;
    try { args = ops.parseArgs(argv, { flags: ['apply', 'allow-different', 'no-service-check', 'copy-to-env'], values: ['db', 'backup', 'env-file', 'unit', 'restore-from'] }); } catch (e) { log(`${e.message}\n${USAGE}`); return 2; }
    if (args.help) { log(USAGE); return 0; }
    const file = ops.dbPath(args);
    if (!fs.existsSync(file)) { log(`error: no database at ${file}`); return 2; }
    const envFile = args['env-file'] || '/etc/openvibe/network.env';
    if (args['copy-to-env']) {
        if (args.backup || args['restore-from']) { log('--copy-to-env takes only --apply, --db and --env-file'); return 2; }
        log(`database   ${file}\nenv file   ${envFile}`);
        return copyToEnv(file, envFile, readEnvFile(envFile), !!args.apply, log);
    }

    // Root-only reads first, then drop to the database owner.
    const envf = args['restore-from'] ? { vars: {} } : readEnvFile(envFile);
    const svc = args['restore-from'] || args['no-service-check'] ? null : readService(args.unit || 'openvibe-network');
    ops.dropToOwnerOf(file, log);

    const db = new Database(file);
    db.pragma('busy_timeout = 5000');
    try {
        log(`database   ${file}`);
        if (args['restore-from']) {
            const backup = new Database(path.resolve(ops.ROOT, args['restore-from']), { readonly: true, fileMustExist: true });
            const saved = new Map(backup.prepare('SELECT key, value FROM site_settings').all().map(r => [r.key, r.value]));
            backup.close();
            const todo = classify(db).filter(c => c.kind !== 'unclassified' && !c.value && saved.get(c.key));
            for (const c of todo) log(`  restore  ${c.key}`);
            log(`${todo.length} setting(s) to restore from ${args['restore-from']}`);
            if (!args.apply) { log('dry run: nothing changed. Re-run with --apply.'); return 0; }
            const up = db.prepare("UPDATE site_settings SET value = ? WHERE key = ? AND (value IS NULL OR value = '')");
            let n = 0;
            db.transaction(() => { for (const c of todo) n += up.run(saved.get(c.key), c.key).changes; })();
            log(`restored   ${n} setting(s). Restart openvibe-network if it should read them again (the environment still wins where set).`);
            return 0;
        }

        log(`env file   ${envFile}${envf.error ? ` (unreadable: ${envf.error}; run with sudo)` : ''}`);
        if (svc) log(`service    ${svc.error ? `unknown (${svc.error})` : `pid ${svc.pid}`}`);
        const plan = [];
        for (const c of classify(db)) {
            const row = { key: c.key, kind: c.kind, db: c.value ? 'value' : 'empty' };
            if (c.kind === 'provider') {
                row.env = c.env;
                const fv = envf.vars ? envf.vars[c.env] : undefined;
                row.envFile = envf.error ? 'unknown' : fv ? (c.value ? (digest(fv) === digest(c.value) ? 'set, same value' : 'set, DIFFERENT value') : 'set') : 'not set';
                const sv = svc && svc.vars ? svc.vars[c.env] : undefined;
                row.service = !svc ? 'not checked' : svc.error ? 'unknown' : sv ? (fv && digest(sv) === digest(fv) ? 'has it' : 'has a different value (restart it)') : 'not set (restart it)';
                if (!c.value) row.action = 'nothing (no database copy)';
                else if (envf.error || !fv) row.action = `keep: put ${c.env} in the env file first`;
                else if (row.envFile.includes('DIFFERENT') && !args['allow-different']) row.action = 'keep: the env file value differs (--allow-different blanks it anyway)';
                else if (svc && row.service !== 'has it') row.action = `keep: the running service does not have this ${c.env} yet (restart openvibe-network)`;
                else row.action = 'BLANK';
            } else if (c.kind === 'unused') {
                row.note = c.note;
                row.action = c.value ? 'BLANK (Network never reads it; the backup keeps it)' : 'nothing (empty)';
            } else {
                row.action = 'keep: not classified by server/secrets.js; review it';
            }
            plan.push(row);
        }
        for (const p of plan) {
            log(`  ${p.key}`);
            log(`      database: ${p.db}${p.env ? ` · variable ${p.env} · env file: ${p.envFile} · service: ${p.service}` : ''}${p.note ? ` · ${p.note}` : ''}`);
            log(`      --apply: ${p.action}`);
        }
        const blank = plan.filter(p => p.action.startsWith('BLANK'));
        log(`${blank.length} setting(s) would be blanked; ${plan.filter(p => p.action.startsWith('keep')).length} kept.`);
        if (!args.apply) { log('dry run: nothing changed. Re-run with --apply --backup <new file>.'); return 0; }
        if (!args.backup) { log('refusing --apply without --backup <new file> (sqlite online backup, 0600)'); return 2; }
        if (envf.error) { log(`refusing --apply: the env file ${envFile} is unreadable`); return 2; }
        if (!blank.length) { log('nothing to blank; no backup taken.'); return 0; }
        const total = db.prepare('SELECT COUNT(*) AS n FROM site_settings').get().n;
        const target = await ops.backupTo(db, args.backup, { expect: { table: 'site_settings', rows: total } });
        log(`backup     ${target} (0600, quick_check ok). It holds the secrets (owner-only, like network.db): delete it once the rollback window is over.`);
        const up = db.prepare("UPDATE site_settings SET value = '' WHERE key = ?");
        let n = 0;
        db.transaction(() => { for (const p of blank) n += up.run(p.key).changes; })();
        log(`blanked    ${n} setting(s): ${blank.map(p => p.key).join(', ')}`);
        return 0;
    } finally { db.close(); }
}

if (require.main === module) {
    // The --copy-to-env child: values go to the parent through a pipe, never to a terminal.
    if (process.env.OV_SECRETS_EMIT === '1' && !process.stdout.isTTY) {
        try { emitValues(ops.dbPath(ops.parseArgs(process.argv.slice(2), { values: ['db'] }))); process.exit(0); } catch (err) { console.error(err.message); process.exit(1); }
    }
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`error: ${err.message}`); process.exit(1); });
}

module.exports = { main, classify, parseEnvText };
