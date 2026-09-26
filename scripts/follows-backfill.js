#!/usr/bin/env node
'use strict';
/**
 * ADR-030 steps 2 and 3 (roadmap WS-E task 4): Live's follows into Network's user_follows, then a
 * reconciliation of the two.
 *
 *   sudo node scripts/follows-backfill.js --live-db /opt/openvibe.live/data/live.db
 *       dry run: how many follows map to subjects, how many would be held (and why), nothing changed
 *   sudo node scripts/follows-backfill.js --live-db … --apply --backup <new file>
 *       takes a sqlite online backup of network.db first (0600, quick_check), then imports in one
 *       transaction: no events (Live already has these follows); a pair whose side has no subject is
 *       kept in follow_import_holds, never dropped
 *   sudo node scripts/follows-backfill.js --live-db … --reconcile
 *       compares every mapped channel's follower count and the pair sets; exit 1 on any difference
 *
 * Live's side is read only (a readonly connection). Live user ids map to subjects through Live's
 * linked_accounts (service 'network', subject_id): the same mapping Live's own reads use.
 *   --db <path>   network.db (default $DB_PATH, else data/network.db)
 */
const fs = require('fs');
const Database = require('better-sqlite3');
const ops = require('./lib/db-ops');
const follows = require('../server/identity/follows');

const USAGE = 'usage: node scripts/follows-backfill.js --live-db <live.db> [--apply --backup <new file> | --reconcile] [--db <network.db>]';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Live's follows and its user id → subject map (readonly). */
function readLive(file) {
    const live = new Database(file, { readonly: true, fileMustExist: true });
    try {
        const rows = live.prepare('SELECT follower_id, streamer_id, email_notify, push_notify, created_at FROM follows ORDER BY id').all()
            .map((r) => ({ follower_ref: r.follower_id, target_ref: r.streamer_id, notify_email: !!r.email_notify, notify_push: !!r.push_notify, created_at: r.created_at ? `${String(r.created_at).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(String(r.created_at)) ? '' : 'Z'}` : null }));
        const subjects = new Map();
        for (const r of live.prepare("SELECT user_id, subject_id FROM linked_accounts WHERE service = 'network' AND subject_id IS NOT NULL").all()) {
            if (SUBJECT_RE.test(String(r.subject_id))) subjects.set(Number(r.user_id), r.subject_id);
        }
        return { rows, subjectOf: (id) => subjects.get(Number(id)) || null };
    } finally { live.close(); }
}

/** Counts per channel and pair sets, Live (mapped) against Network. → { ok, channels, missing, extra } */
function reconcile(db, rows, subjectOf) {
    const livePairs = new Set();
    for (const r of rows) {
        const a = subjectOf(r.follower_ref);
        const b = subjectOf(r.target_ref);
        if (a && b && a !== b) livePairs.add(`${a}>${b}`);
    }
    const netRows = db.prepare("SELECT follower_subject, target_id FROM user_follows WHERE target_type = 'channel' AND active = 1").all();
    const netPairs = new Set(netRows.map((r) => `${r.follower_subject}>${r.target_id}`));
    const missing = [...livePairs].filter((p) => !netPairs.has(p));
    const targets = new Set([...livePairs].map((p) => p.split('>')[1]));
    // Network may hold follows Live does not (made on Network after the import); only mapped channels are compared.
    const extra = [...netPairs].filter((p) => targets.has(p.split('>')[1]) && !livePairs.has(p));
    const channels = [...targets].map((t) => ({
        channel: t,
        live: [...livePairs].filter((p) => p.endsWith(`>${t}`)).length,
        network: follows.count(db, 'channel', t),
    }));
    return { ok: !missing.length && !extra.length && channels.every((c) => c.live === c.network), channels, missing, extra };
}

async function main(argv, log = console.log) {
    let args;
    try { args = ops.parseArgs(argv, { flags: ['apply', 'reconcile'], values: ['db', 'backup', 'live-db'] }); } catch (e) { log(`${e.message}\n${USAGE}`); return 2; }
    if (args.help || !args['live-db']) { log(USAGE); return args.help ? 0 : 2; }
    const file = ops.dbPath(args);
    if (!fs.existsSync(file)) { log(`error: no database at ${file}`); return 2; }
    const { rows, subjectOf } = readLive(args['live-db']);
    ops.dropToOwnerOf(file, log);
    const db = new Database(file);
    db.pragma('busy_timeout = 5000');
    try {
        follows.ensureSchema(db);
        if (args.reconcile) {
            const r = reconcile(db, rows, subjectOf);
            log(`live follows ${rows.length}; channels compared ${r.channels.length}; missing on Network ${r.missing.length}; on Network only ${r.extra.length}`);
            for (const c of r.channels.filter((x) => x.live !== x.network)) log(`  count differs: ${c.channel} live ${c.live} network ${c.network}`);
            log(r.ok ? 'RECONCILED: counts and pairs match' : 'NOT RECONCILED');
            return r.ok ? 0 : 1;
        }
        const plan = follows.importFollows(db, 'live', rows, subjectOf, { dryRun: true });
        log(`live follows ${rows.length}: import ${plan.imported}, already on Network ${plan.unchanged}, held ${plan.held.length}`);
        const reasons = {};
        for (const h of plan.held) reasons[h.reason] = (reasons[h.reason] || 0) + 1;
        for (const [k, v] of Object.entries(reasons)) log(`  held (${k}): ${v}`);
        if (!args.apply) { log('dry run: nothing changed. Re-run with --apply --backup <new file>.'); return 0; }
        if (!args.backup) { log('refusing --apply without --backup <new file> (sqlite online backup, 0600)'); return 2; }
        const target = await ops.backupTo(db, args.backup, { expect: { table: 'users', rows: db.prepare('SELECT COUNT(*) AS n FROM users').get().n } });
        log(`backup     ${target} (0600, quick_check ok)`);
        const out = follows.importFollows(db, 'live', rows, subjectOf);
        log(`imported   ${out.imported}; already there ${out.unchanged}; held ${out.held.length} (follow_import_holds)`);
        const r = reconcile(db, rows, subjectOf);
        log(r.ok ? 'RECONCILED: counts and pairs match' : `NOT RECONCILED: missing ${r.missing.length}, extra ${r.extra.length}`);
        return r.ok ? 0 : 1;
    } finally { db.close(); }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`error: ${err.message}`); process.exit(1); });

module.exports = { main, readLive, reconcile };
