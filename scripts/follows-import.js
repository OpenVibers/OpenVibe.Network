#!/usr/bin/env node
/**
 * ADR-030 backfill (plan T2 "Follows"): Live's follows into Network's user_follows, the graph go-live
 * notifications read (server/notifications/events-consumer.js). Follows made on Live while Live's own
 * FOLLOWS_AUTHORITY was unset never reached Network, so run this before (and, to be sure, after) the
 * release that stops asking Live for followers.
 *
 *   npm run follows-import -- --live-db /opt/openvibe.live/data/live.db            # dry run: counts only
 *   npm run follows-import -- --live-db /opt/openvibe.live/data/live.db --apply    # import, one transaction
 *
 * Live's side is read only (a readonly SQLite connection). Live user ids map to subjects through Live's
 * linked_accounts (service 'network', subject_id), the mapping Live's own reads use. The database written is
 * the service's own PostgreSQL (DATABASE_URL), opened without migrating or seeding. Each pair goes through importFollows()
 * (server/identity/follows.js): no events and no notifications (Live already has these follows); a pair whose
 * side has no subject is kept in follow_import_holds, never dropped; a pair Network already has, followed or
 * unfollowed since, is left alone. Safe to run again: a second run imports nothing. Prints counts only.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const follows = require('../server/identity/follows');

const USAGE = 'usage: npm run follows-import -- --live-db <live.db> [--apply]';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') out.apply = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--live-db') {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw new Error('--live-db needs a value');
            out.liveDb = v;
        } else throw new Error(`unknown argument ${a}`);
    }
    return out;
}

/** A SQLite file: better-sqlite3, else Node's built-in node:sqlite (when the native module is not built for this Node). */
function openSqlite(file, { readonly = true } = {}) {
    try {
        const Database = require('better-sqlite3');
        return new Database(file, { readonly, fileMustExist: readonly });
    } catch (e) {
        if (!/better-sqlite3|NODE_MODULE_VERSION|Cannot find module/.test(e.message)) throw e;
        const { DatabaseSync } = require('node:sqlite');
        return new DatabaseSync(file, { readOnly: readonly });
    }
}

/** Live's follows and its user id → subject map (readonly). → { rows, subjectOf } */
function readLive(file) {
    const live = openSqlite(file);
    try {
        const rows = live.prepare('SELECT follower_id, streamer_id, email_notify, push_notify, created_at FROM follows ORDER BY id').all()
            .map((r) => ({ follower_ref: r.follower_id, target_ref: r.streamer_id, notify_email: !!r.email_notify, notify_push: !!r.push_notify, created_at: liveTime(r.created_at) }));
        const subjects = new Map();
        for (const r of live.prepare("SELECT user_id, subject_id FROM linked_accounts WHERE service = 'network' AND subject_id IS NOT NULL").all()) {
            if (SUBJECT_RE.test(String(r.subject_id))) subjects.set(Number(r.user_id), r.subject_id);
        }
        return { rows, subjectOf: (id) => subjects.get(Number(id)) || null };
    } finally { live.close(); }
}

/** SQLite's CURRENT_TIMESTAMP ('2026-01-02 03:04:05', UTC) as ISO 8601; anything unreadable → null (now). */
function liveTime(v) {
    if (!v) return null;
    const s = String(v).replace(' ', 'T');
    const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Open the service database: the injected handle (tests), else DATABASE_URL as the service uses it (no migration, no seeding). */
async function openDb(injected) {
    if (injected) return injected;
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set: the follows live in the service database');
    const { createDb } = require('openvibe-sdk/db');
    return createDb({ url: process.env.DATABASE_URL, service: 'network-follows-import', max: 1 });
}

async function main(argv, { db: injected, log = console.log } = {}) {
    let args;
    try { args = parseArgs(argv); } catch (e) { log(`${e.message}\n${USAGE}`); return 2; }
    if (args.help) { log(USAGE); return 0; }
    if (!args.liveDb) { log(USAGE); return 2; }
    const file = path.resolve(process.cwd(), args.liveDb);
    if (!fs.existsSync(file)) { log(`error: ${args.liveDb} does not exist`); return 2; }
    let live;
    try { live = readLive(file); } catch (e) { log(`error: cannot read Live's follows: ${e.message}`); return 2; }
    const db = await openDb(injected);
    const out = await follows.importFollows(db, 'live', live.rows, live.subjectOf, { dryRun: !args.apply });
    const held = {};
    for (const h of out.held) held[h.reason] = (held[h.reason] || 0) + 1;
    const why = Object.entries(held).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    log(`live rows  ${live.rows.length}; ${args.apply ? 'imported' : 'to import'} ${out.imported}; already on Network ${out.unchanged}; held: ${why}`);
    if (!args.apply) log(out.imported || out.held.length ? 'dry run: nothing changed. Re-run with --apply to import.' : 'nothing to import.');
    return 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`error: ${err.message}`); process.exit(1); });

module.exports = { main, readLive, liveTime, openSqlite };
