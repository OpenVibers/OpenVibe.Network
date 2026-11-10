#!/usr/bin/env node
'use strict';
// Run with the service environment. Default dry run; --apply explicitly writes through the same ledger.
const { earned } = require('../server/levels/coins');
async function backfill(db, { apply = false } = {}) {
    const counts = { scanned: 0, eligible: 0, existing: 0, awarded: 0, xp: 0 };
    let after = 0;
    while (true) {
        const rows = await db.prepare(`SELECT c.id, c.user_id, c.app_id, c.delta, c.reason, c.idempotency_key, c.created_at
            FROM coin_transactions c JOIN users u ON u.id = c.user_id
            WHERE c.id > ? AND c.delta > 0 AND u.deleted_at IS NULL ORDER BY c.id LIMIT 500`).all(after);
        if (!rows.length) break;
        for (const row of rows) {
            after = Number(row.id); counts.scanned++;
            if (!earned(row)) continue;
            // Earn history follows an existing account merge, but never resurrects a deleted person.
            let owner = await db.prepare('SELECT id, merged_into, deleted_at, is_banned, is_anon FROM users WHERE id = ?').get(row.user_id);
            const visited = new Set();
            while (owner?.merged_into && !visited.has(owner.id)) {
                visited.add(owner.id);
                owner = await db.prepare('SELECT id, merged_into, deleted_at, is_banned, is_anon FROM users WHERE id = ?').get(owner.merged_into);
            }
            if (!owner || owner.merged_into || owner.deleted_at || Number(owner.is_banned) || Number(owner.is_anon)) continue;
            counts.eligible++;
            const key = `coin:${row.idempotency_key}`;
            if (await db.prepare("SELECT 1 FROM experience_events WHERE service = 'opencoins' AND idempotency_key = ?").get(key)) { counts.existing++; continue; }
            counts.xp += Number(row.delta);
            if (apply) {
                try { await db.tx(() => require('../server/levels/store').append(db, { user_id: owner.id, service: 'opencoins', reason: 'quest.completed', amount: Number(row.delta), idempotency_key: key, at: new Date(row.created_at).toISOString(), backfill: true })); counts.awarded++; }
                catch (e) { if (e.code === 'levels.duplicate') counts.existing++; else throw e; }
            }
        }
    }
    return { mode: apply ? 'apply' : 'dry-run', ...counts };
}
if (require.main === module) {
    // No migrations or seed writes: production schema changes happen only at deploy.
    const { createDb } = require('openvibe-sdk/db');
    if (!process.env.DATABASE_URL) throw new Error('run with the service environment');
    const db = createDb({ url: process.env.DATABASE_URL, service: 'network-levels-backfill', max: 1 });
    backfill(db, { apply: process.argv.includes('--apply') }).then(result => console.log(JSON.stringify(result)))
        .catch(() => { console.error('experience backfill failed'); process.exitCode = 1; }).finally(() => db.close());
}
module.exports = { backfill };
