#!/usr/bin/env node
/**
 * Provider secrets out of site_settings (roadmap §18.2(12); server/secrets.js). Network reads each secret
 * from its environment variable first and from site_settings only as a fallback; this script is how the
 * operator empties the database copies once the environment has them. It prints setting and variable
 * NAMES, never a value (values are compared by SHA-256 only).
 *
 *   node scripts/secrets-out-of-db.js
 *       dry run: every secret setting by name, whether the database holds a value, its variable, whether
 *       the env file sets it (and to the same value), and whether the running service has it
 *   node scripts/secrets-out-of-db.js --copy-to-env [--apply]
 *       for each secret the database holds and the env file does not set, append VAR=value to the env
 *       file (after copying it to <env file>.bak-<time>, same mode), so the values move without anyone
 *       seeing them: the values go to the file through this process, never to the terminal. Dry run
 *       without --apply. Restart the service after.
 *   node scripts/secrets-out-of-db.js --apply --backup <new file> [--allow-different]
 *       writes the secret settings to a new owner-only (0600) JSON backup, then blanks the database copy of
 *         - each secret whose variable the env file sets to the same value (a different value only with
 *           --allow-different) AND the running service already has (restart it after editing the file)
 *         - each secret setting Network never reads (Net tools tokens, old SES keys)
 *       and leaves every other one as it is, saying why
 *   node scripts/secrets-out-of-db.js --restore-from <backup> [--apply]
 *       rollback: puts the backed-up value back into each secret setting that is blank now
 *
 * On PostgreSQL (plan T2, ADR-035) the settings live in the service database: the script reads and writes
 * them through DATABASE_URL, exactly as the service does. --backup writes a JSON file (0600)
 * holding the values being blanked.
 *
 *   --env-file <path>     default /etc/openvibe/network.env
 *   --unit <name>         systemd unit whose running process must already have the variables
 *                         (default openvibe-network); --no-service-check skips that check
 *
 * Run with sudo: the env file and the service's environment are root-only.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { parseArgs } = require('./lib/db-ops');
const secrets = require('../server/secrets');
const { isSensitiveSettingKey } = require('../server/auth/owner-guard');

const USAGE = `usage: sudo node scripts/secrets-out-of-db.js [--env-file <path>] [--unit <name> | --no-service-check]
       sudo node scripts/secrets-out-of-db.js --copy-to-env [--apply]
       sudo node scripts/secrets-out-of-db.js --apply --backup <new file> [--allow-different]
       sudo node scripts/secrets-out-of-db.js --restore-from <backup> [--apply]`;

// Settings that look sensitive by name but are not secrets.
const NOT_SECRET = new Set(['discord_oauth_client_id', 'vapid_public_key', 'vapid_contact_email']);

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

/** Open the service database: the injected handle (tests), else DATABASE_URL as the service uses it. */
async function openDb(injected) {
    if (injected) return injected;
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set: the settings live in the service database');
    const { createDb } = require('openvibe-sdk/db');
    return createDb({ url: process.env.DATABASE_URL, service: 'network-secrets', max: 1 });
}

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
async function classify(db) {
    const rows = await db.prepare('SELECT key, value, type FROM site_settings').all();
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

/** The database's provider values: { ENV_NAME: value }. */
async function readValues(db) {
    const get = db.prepare('SELECT value FROM site_settings WHERE key = ?');
    const out = {};
    for (const s of secrets.SECRETS) { const r = await get.get(s.key); if (r && r.value) out[s.env] = String(r.value); }
    return out;
}

async function copyToEnv(db, envFile, envf, apply, log, now = new Date()) {
    if (envf.error) { log(`error: the env file ${envFile} is unreadable (${envf.error}); run with sudo`); return 2; }
    const values = await readValues(db);
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
    fs.appendFileSync(envFile, `${text.endsWith('\n') || !text ? '' : '\n'}# Provider secrets moved from site_settings (scripts/secrets-out-of-db.js, ${now.toISOString()})\n${add.map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
    log(`env file   ${envFile}: appended ${add.map(([k]) => k).join(', ')} (previous version: ${bak}). Restart openvibe-network, then run --apply --backup <new file>.`);
    return 0;
}

/** Write the site_settings rows to a NEW owner-only JSON backup; refuses an existing target. */
function writeBackup(target, rows, log) {
    const file = path.resolve(target);
    if (fs.existsSync(file)) throw new Error(`backup target ${file} already exists; choose a new path`);
    const umask = process.umask(0o077);
    try { fs.writeFileSync(file, JSON.stringify({ taken_at: new Date().toISOString(), settings: rows }, null, 2)); } finally { process.umask(umask); }
    fs.chmodSync(file, 0o600);
    log(`backup     ${file} (0600). It holds the site_settings rows (owner-only): delete it once the rollback window is over.`);
    return file;
}

async function main(argv, log = console.log, { readService = serviceEnv, db: injected } = {}) {
    let args;
    try { args = parseArgs(argv, { flags: ['apply', 'allow-different', 'no-service-check', 'copy-to-env'], values: ['backup', 'env-file', 'unit', 'restore-from'] }); } catch (e) { log(`${e.message}\n${USAGE}`); return 2; }
    if (args.help) { log(USAGE); return 0; }
    const envFile = args['env-file'] || '/etc/openvibe/network.env';

    let db;
    try { db = await openDb(injected); } catch (e) { log(`error: ${e.message}`); return 2; }
    try {
        if (args['copy-to-env']) {
            if (args.backup || args['restore-from']) { log('--copy-to-env takes only --apply and --env-file'); return 2; }
            log(`env file   ${envFile}`);
            return await copyToEnv(db, envFile, readEnvFile(envFile), !!args.apply, log);
        }

        const envf = args['restore-from'] ? { vars: {} } : readEnvFile(envFile);
        const svc = args['restore-from'] || args['no-service-check'] ? null : readService(args.unit || 'openvibe-network');

        log('database   DATABASE_URL');
        if (args['restore-from']) {
            const backup = JSON.parse(fs.readFileSync(path.resolve(args['restore-from']), 'utf8'));
            const saved = new Map((backup.settings || []).map(r => [r.key, r.value]));
            const todo = (await classify(db)).filter(c => c.kind !== 'unclassified' && !c.value && saved.get(c.key));
            for (const c of todo) log(`  restore  ${c.key}`);
            log(`${todo.length} setting(s) to restore from ${args['restore-from']}`);
            if (!args.apply) { log('dry run: nothing changed. Re-run with --apply.'); return 0; }
            await db.tx(async (t) => {
                let n = 0;
                for (const c of todo) { n += (await t.prepare("UPDATE site_settings SET value = ? WHERE key = ? AND (value IS NULL OR value = '')").run(saved.get(c.key), c.key)).changes; }
                log(`restored   ${n} setting(s). Restart openvibe-network if it should read them again (the environment still wins where set).`);
            });
            return 0;
        }

        log(`env file   ${envFile}${envf.error ? ` (unreadable: ${envf.error}; run with sudo)` : ''}`);
        if (svc) log(`service    ${svc.error ? `unknown (${svc.error})` : `pid ${svc.pid}`}`);
        const plan = [];
        for (const c of await classify(db)) {
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
        if (!args.backup) { log('refusing --apply without --backup <new file> (owner-only JSON, 0600)'); return 2; }
        if (envf.error) { log(`refusing --apply: the env file ${envFile} is unreadable`); return 2; }
        if (!blank.length) { log('nothing to blank; no backup taken.'); return 0; }
        const rows = await db.prepare('SELECT key, value FROM site_settings').all();
        writeBackup(args.backup, rows, log);
        await db.tx(async (t) => {
            const up = t.prepare("UPDATE site_settings SET value = '' WHERE key = ?");
            let n = 0;
            for (const p of blank) n += (await up.run(p.key)).changes;
            log(`blanked    ${n} setting(s): ${blank.map(p => p.key).join(', ')}`);
        });
        return 0;
    } finally { if (!injected) await db.close().catch(() => {}); }
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`error: ${err.message}`); process.exit(1); });
}

module.exports = { main, classify, parseEnvText };
