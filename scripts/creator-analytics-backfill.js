#!/usr/bin/env node
'use strict';
/**
 * Creator analytics history (roadmap WS-E task 6): Live's ended streams of the last 400 days into Network's
 * creator_streams, so switching Live's /api/analytics to Network (ANALYTICS_SOURCE=network) loses no history.
 * Events only carry `stats` since Contracts 0.68.0; older streams come from Live's own tables here.
 *
 *   sudo node scripts/creator-analytics-backfill.js --live-db /opt/openvibe.live/data/live.db            dry run
 *   sudo node scripts/creator-analytics-backfill.js --live-db … --apply --backup <new file>              import
 *
 * Live's database is read only. A stream whose channel has no Network subject is skipped (counted). Rows
 * already in creator_streams (from events) are kept as they are. Counts only, as the events carry.
 *   --db <path>   network.db (default $DB_PATH, else data/network.db)
 */
const fs = require('fs');
const Database = require('better-sqlite3');
const ops = require('./lib/db-ops');
const creators = require('../server/analytics/creators');

const USAGE = 'usage: node scripts/creator-analytics-backfill.js --live-db <live.db> [--apply --backup <new file>] [--db <network.db>]';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const iso = (v) => { if (!v) return null; const d = new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);

function readLive(file, now = Date.now()) {
    const live = new Database(file, { readonly: true, fileMustExist: true });
    try {
        const since = new Date(now - creators.KEEP_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19);
        return live.prepare(`SELECT s.id, s.title, s.category, s.started_at, s.ended_at, s.duration_seconds, s.peak_viewers,
                sa.avg_viewers, sa.unique_chatters, sa.total_messages, sa.total_watch_minutes, la.subject_id
            FROM streams s
            LEFT JOIN stream_analytics sa ON sa.stream_id = s.id
            LEFT JOIN linked_accounts la ON la.user_id = s.user_id AND la.service = 'network'
            WHERE s.ended_at IS NOT NULL AND s.duration_seconds > 0 AND s.started_at >= ?
            ORDER BY s.id`).all(since);
    } finally { live.close(); }
}

async function main(argv, log = console.log) {
    let args;
    try { args = ops.parseArgs(argv, { flags: ['apply'], values: ['db', 'backup', 'live-db'] }); } catch (e) { log(`${e.message}\n${USAGE}`); return 2; }
    if (args.help || !args['live-db']) { log(USAGE); return args.help ? 0 : 2; }
    const file = ops.dbPath(args);
    if (!fs.existsSync(file)) { log(`error: no database at ${file}`); return 2; }
    const rows = readLive(args['live-db']);
    ops.dropToOwnerOf(file, log);
    const db = new Database(file);
    db.pragma('busy_timeout = 5000');
    try {
        creators.ensureSchema(db);
        const has = db.prepare('SELECT 1 FROM creator_streams WHERE stream_id = ?');
        const plan = { import: [], kept: 0, no_subject: 0, bad: 0 };
        for (const r of rows) {
            if (!SUBJECT_RE.test(String(r.subject_id || ''))) { plan.no_subject++; continue; }
            const started = iso(r.started_at); const ended = iso(r.ended_at);
            if (!started || !ended || ended < started) { plan.bad++; continue; }
            if (has.get(r.id)) { plan.kept++; continue; }
            plan.import.push({ ...r, started, ended });
        }
        log(`live ended streams (400 days) ${rows.length}: import ${plan.import.length}, already on Network ${plan.kept}, channel without a subject ${plan.no_subject}, bad times ${plan.bad}`);
        if (!args.apply) { log('dry run: nothing changed. Re-run with --apply --backup <new file>.'); return 0; }
        if (!args.backup) { log('refusing --apply without --backup <new file> (sqlite online backup, 0600)'); return 2; }
        const target = await ops.backupTo(db, args.backup, { expect: { table: 'users', rows: db.prepare('SELECT COUNT(*) AS n FROM users').get().n } });
        log(`backup     ${target} (0600, quick_check ok)`);
        const ins = db.prepare(`INSERT OR IGNORE INTO creator_streams (stream_id, creator_subject, title, category, started_at, ended_at, duration_seconds, peak_viewers, avg_viewers, unique_chatters, messages, watch_minutes, received_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const at = new Date().toISOString();
        db.transaction(() => {
            for (const r of plan.import) {
                ins.run(r.id, r.subject_id, r.title == null ? null : String(r.title).slice(0, 300), r.category == null ? null : String(r.category).slice(0, 100), r.started, r.ended, n(r.duration_seconds) || 0,
                    n(r.peak_viewers), r.avg_viewers == null ? null : Math.round(Number(r.avg_viewers) * 10) / 10, n(r.unique_chatters), n(r.total_messages), n(r.total_watch_minutes), at);
            }
        })();
        log(`imported   ${plan.import.length}`);
        return 0;
    } finally { db.close(); }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`error: ${err.message}`); process.exit(1); });

module.exports = { main, readLive };
