#!/usr/bin/env node
/**
 * Raw analytics retention and one-time scrub for Network's analytics tables (ADR-021). They live in
 * network.db, Network's identity database, next to users and sessions.
 *
 *   node scripts/analytics-prune.js                          # dry run: counts only, changes nothing
 *   node scripts/analytics-prune.js --scrub                  # dry run including what the scrub would rewrite
 *   node scripts/analytics-prune.js --apply --backup <file>  # online backup to <file>, then prune
 *   node scripts/analytics-prune.js --apply --scrub --backup <file>
 *   node scripts/analytics-prune.js --apply --no-backup      # prune without a backup (explicit)
 *
 * Options:
 *   --db <file>      database (default: $DB_PATH, else data/network.db; relative paths from the repo root)
 *   --days <n>       keep raw events newer than n days, 1..30 (default 30)
 *   --scrub          after pruning, rewrite the remaining rows: ip/user_id/city → NULL, path → route
 *                    template (with Network's path rules: /avatar/<name>, /users/by-username/<name>,
 *                    /api/auth/anon/<token>), referer → origin, user_agent → class, legacy session
 *                    ids → NULL; same path/referer reduction in the rollups' top lists (counts untouched)
 *   --no-vacuum      skip the VACUUM that follows an --apply (VACUUM rewrites the file so pruned and
 *                    scrubbed values do not survive in free pages; it needs ~2x the database size free).
 *                    VACUUM rewrites all of network.db and holds its write lock meanwhile: Network's own
 *                    writes (sign-ins, sessions) wait 5 s and then fail. Vacuum with the service stopped,
 *                    or pass --no-vacuum while it is up.
 *   --batch <n>      rows per write batch (default 5000)
 *
 * --apply refuses to run without --backup <file> (a new file, mode 0600 — it is a full copy of
 * network.db; sqlite online backup, verified) or an explicit --no-backup. Rollup totals are compared
 * before and after; any difference exits 1. Prune and scrub are safe while the server is up (short
 * batches; the tracker retries a busy flush). Run as the service user so no file changes owner.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const retention = require('../server/analytics/retention');
const networkAnalytics = require('../server/analytics/network');

const ROOT = path.join(__dirname, '..');
const HELP_LINES = 29; // header lines 3..29
const { paramPrefixes } = networkAnalytics.PATH_OPTS;

function parseArgs(argv) {
    const a = { apply: false, scrub: false, vacuum: true, backup: null, noBackup: false, days: retention.MAX_DAYS, batch: retention.DEFAULT_BATCH, db: null };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const val = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
        if (k === '--apply') a.apply = true;
        else if (k === '--scrub') a.scrub = true;
        else if (k === '--no-vacuum') a.vacuum = false;
        else if (k === '--no-backup') a.noBackup = true;
        else if (k === '--backup') a.backup = val();
        else if (k === '--days') a.days = Number(val());
        else if (k === '--batch') a.batch = Number(val());
        else if (k === '--db') a.db = val();
        else if (k === '-h' || k === '--help') a.help = true;
        else throw new Error(`unknown option ${k}`);
    }
    retention.checkDays(a.days);
    if (!Number.isInteger(a.batch) || a.batch < 1 || a.batch > 100000) throw new Error('--batch must be 1..100000');
    if (a.backup && a.noBackup) throw new Error('--backup and --no-backup are exclusive');
    return a;
}

/** The database the server uses: --db, else $DB_PATH, else data/network.db (relative to the repo root). */
function defaultDbPath(args, env = process.env) {
    return path.resolve(ROOT, args.db || env.DB_PATH || path.join('data', 'network.db'));
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
function fileBytes(f) { try { return fs.statSync(f).size; } catch { return 0; } }
function freeBytes(dir) { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; } }
const sameTotals = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main(argv, log = console.log) {
    let args;
    try { args = parseArgs(argv); } catch (e) { log(`error: ${e.message}`); return 2; }
    if (args.help) { log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, HELP_LINES).join('\n')); return 0; }
    const dbPath = defaultDbPath(args);
    if (!fs.existsSync(dbPath)) { log(`error: ${dbPath} does not exist`); return 2; }

    if (args.apply && !args.backup && !args.noBackup) {
        log('refusing --apply without a backup: pass --backup <new file> (sqlite online backup) or --no-backup');
        return 2;
    }

    const db = new Database(dbPath, args.apply ? { fileMustExist: true } : { readonly: true, fileMustExist: true });
    try {
        db.pragma('busy_timeout = 5000');
        const walBytes = fileBytes(dbPath + '-wal');
        const before = retention.inspect(db, { days: args.days, paramPrefixes });
        log(`database   ${dbPath}`);
        log(`size       ${mb(before.bytes)} (+ ${mb(walBytes)} WAL); a backup needs about ${mb(before.bytes + walBytes)}; VACUUM about ${mb(2 * before.bytes)} more`);
        log(`raw events ${before.events} (oldest ${before.oldest || '-'}, newest ${before.newest || '-'})`);
        log(`prune      ${before.older} rows created before ${before.cutoff} UTC (${args.days} days); ${before.remaining} stay`);
        if (before.toScrub) {
            const t = before.toScrub;
            log(`scrub      of the rows that stay: ${t.personal} with ip/user_id/city, ${t.paths} paths to template, ${t.referers} referers to origin, ${t.user_agents} user agents to class, ${t.sessions} legacy session ids${args.scrub ? '' : '  (needs --scrub)'}`);
        }
        log(`rate rows  ${before.rateRows || 0} (IP counters; the server keeps them in memory now)`);
        for (const [k, v] of Object.entries(before.rollups)) log(`rollups    ${k}: ${v.rows} rows, ${v.pageviews} pageviews, ${v.api_calls} api calls (kept)`);

        if (!args.apply) {
            log('\ndry run: nothing changed. Re-run with --apply --backup <file> (or --no-backup).');
            return 0;
        }

        if (args.backup) {
            const target = path.resolve(args.backup);
            if (fs.existsSync(target)) { log(`error: backup target ${target} already exists; choose a new file`); return 2; }
            const need = before.bytes + walBytes;
            const free = freeBytes(path.dirname(target));
            if (free != null && free < need * 1.1) { log(`error: ${mb(free)} free at ${path.dirname(target)}, the backup needs about ${mb(need)}`); return 2; }
            // A full copy of network.db (accounts, sessions): owner-only from the first byte.
            const umask = process.umask(0o077);
            try { await db.backup(target); } finally { process.umask(umask); }
            fs.chmodSync(target, 0o600);
            const b = new Database(target, { readonly: true });
            try {
                const ok = b.pragma('quick_check', { simple: true });
                const n = b.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'analytics_events'").pluck().get()
                    ? b.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get() : 0;
                if (ok !== 'ok' || n < before.events) { log(`error: backup check failed (quick_check=${ok}, rows=${n})`); return 1; }
            } finally { b.close(); }
            log(`backup     ${target} (${mb(fileBytes(target))}, mode 0600, quick_check ok)`);
        }

        db.pragma('secure_delete = ON');
        const totalsBefore = retention.rollupTotals(db);
        const pruned = await retention.pruneRawEvents(db, { days: args.days, batchSize: args.batch });
        log(`pruned     ${pruned.deleted} rows in ${pruned.batches} batches`);
        if (args.scrub) {
            await networkAnalytics.prescrub(db, { batchSize: args.batch });
            const s = await retention.scrubEvents(db, { batchSize: args.batch, paramPrefixes });
            const r = retention.scrubRollups(db, { paramPrefixes });
            log(`scrubbed   ${s.rows} raw rows in ${s.batches} batches; rollup top lists rewritten in ${r.hourly} hourly and ${r.daily} daily rows`);
        }
        const totalsAfter = retention.rollupTotals(db);
        if (!sameTotals(totalsBefore, totalsAfter)) {
            log(`error: rollup totals changed!\n before ${JSON.stringify(totalsBefore)}\n after  ${JSON.stringify(totalsAfter)}`);
            return 1;
        }
        log('rollups    totals unchanged');
        if (args.vacuum && (pruned.deleted || args.scrub)) {
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.exec('VACUUM');
            db.pragma('wal_checkpoint(TRUNCATE)');
            log(`vacuumed   ${mb(fileBytes(dbPath))}`);
        }
        const after = retention.inspect(db, { days: args.days, paramPrefixes });
        log(`now        ${after.events} raw events, ${after.older} older than ${args.days} days${after.toScrub ? `, ${after.toScrub.personal} with ip/user_id/city` : ''}`);
        return 0;
    } finally {
        db.close();
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}

module.exports = { main, parseArgs, defaultDbPath };
