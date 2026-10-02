#!/usr/bin/env node
/**
 * Read-only preflight for go-live notifications from Network's own follow graph (plan T2 "Follows"): how many
 * follows Network holds and how many imported pairs are still waiting for a subject. Counts only: no subjects,
 * usernames or Live ids are printed. Changes nothing.
 *
 *   npm run follows-preflight
 *
 * The database is the service's own PostgreSQL (DATABASE_URL), opened without migrating or seeding. A pair held in
 * follow_import_holds is resolved by running npm run follows-import again once both sides have a subject.
 */
'use strict';

/** → { active, channels, followers, inactive, holds: { total, by_reason: { reason: n } } } */
async function counts(db) {
    const f = await db.prepare(`SELECT
        COUNT(*) FILTER (WHERE active = 1) AS active,
        COUNT(DISTINCT target_id) FILTER (WHERE active = 1) AS channels,
        COUNT(DISTINCT follower_subject) FILTER (WHERE active = 1) AS followers,
        COUNT(*) FILTER (WHERE active <> 1) AS inactive
        FROM user_follows WHERE target_type = 'channel'`).get();
    const holds = await db.prepare('SELECT source, reason, COUNT(*) AS n FROM follow_import_holds GROUP BY source, reason ORDER BY source, reason').all();
    const byReason = {};
    for (const h of holds) byReason[`${h.source}:${h.reason}`] = Number(h.n);
    return {
        active: Number(f.active), channels: Number(f.channels), followers: Number(f.followers), inactive: Number(f.inactive),
        holds: { total: Object.values(byReason).reduce((a, n) => a + n, 0), by_reason: byReason },
    };
}

/** Open the service database: the injected handle (tests), else DATABASE_URL as the service uses it (no migration, no seeding). */
async function openDb(injected) {
    if (injected) return injected;
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set: the follows live in the service database');
    const { createDb } = require('openvibe-sdk/db');
    return createDb({ url: process.env.DATABASE_URL, service: 'network-follows-preflight', max: 1 });
}

async function main(argv, { db: injected, log = console.log } = {}) {
    if (argv.includes('--help') || argv.includes('-h')) { log('usage: npm run follows-preflight'); return 0; }
    if (argv.length) { log(`unknown argument ${argv[0]}\nusage: npm run follows-preflight`); return 2; }
    const db = await openDb(injected);
    const c = await counts(db);
    const why = Object.entries(c.holds.by_reason).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    log(`active follows     ${c.active} (${c.channels} channels, ${c.followers} followers)\nunfollowed rows    ${c.inactive}\nunresolved holds   ${c.holds.total}${c.holds.total ? ` (${why})` : ''}`);
    return 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`error: ${err.message}`); process.exit(1); });

module.exports = { main, counts };
