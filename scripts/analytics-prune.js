#!/usr/bin/env node
/**
 * ADR-021 raw analytics retention and the one-time scrub of pre-ADR rows, on Network's own PostgreSQL
 * (plan T2, ADR-035). The analytics tables live in the service database next to users and sessions
 * (migrations/0002_analytics.sql); the tracker itself schedules the prune at boot, this is the on-demand
 * operator form.
 *
 *   node scripts/analytics-prune.js                # dry run: how many raw events would go, nothing changes
 *   node scripts/analytics-prune.js --apply        # delete raw events older than --days
 *
 *   --days <n>   keep raw events newer than n days, 1..30 (default 30)
 *   --apply      actually prune (default: dry run)
 *
 * openvibe-shared's pruneRawEventsPg handles retention. Run it where Network runs, or with
 * DATABASE_URL/DATABASE_DIRECT_URL pointing at a copy; it needs no elevated privileges.
 */
'use strict';
const { parseArgs } = require('./lib/db-ops');
const { pruneRawEventsPg } = require('openvibe-shared/analytics/pg');

const USAGE = `Raw analytics retention (ADR-021, PostgreSQL).

  node scripts/analytics-prune.js                dry run: counts only, changes nothing
  node scripts/analytics-prune.js --apply        delete raw events older than --days

Options:
  --days <n>   keep raw events newer than n days, 1..30 (default 30)
  --apply      actually prune`;

/** UTC 'YYYY-MM-DD HH:MM:SS', the analytics rows' time shape. */
function sqlTime(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Open the service database: the injected handle (tests), else DATABASE_URL as the service uses it. */
async function openDb(injected) {
    if (injected) return injected;
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set: the analytics tables live in the service database');
    const { createDb } = require('openvibe-sdk/db');
    return createDb({ url: process.env.DATABASE_URL, service: 'network-analytics-prune', max: 1 });
}

async function main(argv = process.argv.slice(2), { db: injected, log = console } = {}) {
    const args = parseArgs(argv, { flags: ['apply', 'help'], values: ['days'] });
    if (args.help) { log.log(USAGE); return 0; }
    const days = Number(args.days || 30);
    if (!Number.isInteger(days) || days < 1 || days > 30) { log.error('--days must be an integer 1..30'); return 2; }

    const db = await openDb(injected);
    if (!args.apply) {
        const n = (await db.prepare('SELECT COUNT(*) AS n FROM analytics_events WHERE created_at < ?').get(sqlTime(Date.now() - days * 86400000))).n;
        log.log(`dry run: ${n} raw event(s) older than ${days} day(s) would go; rollups stay. Re-run with --apply to prune.`);
        return 0;
    }

    const { removed, cutoff } = await pruneRawEventsPg(db, { days });
    log.log(`pruned ${removed} raw event(s) older than ${cutoff} (${days} day(s)); rollups stay.`);
    return 0;
}

if (require.main === module) main().then((code) => process.exit(code), (err) => { console.error(`error: ${err.message}`); process.exit(1); });

module.exports = { main, sqlTime, USAGE };
