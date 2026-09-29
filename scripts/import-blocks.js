#!/usr/bin/env node
/**
 * Import blocks made elsewhere into platform blocks (roadmap WS-E task 5). The input is the JSON file
 * OpenVibe.Chat's scripts/migrate-dm-blocks-to-network.js writes from its dm_blocks table:
 *
 *   { "pairs": [{ "blocker_subject": "usr_…", "blocked_subject": "usr_…" }, …] }   (a bare array works too)
 *
 *   node scripts/import-blocks.js --file <json>            # dry run: what would be imported, nothing changes
 *   node scripts/import-blocks.js --file <json> --apply    # insert the blocks and queue their events
 *
 * The database is the service's own PostgreSQL (DATABASE_URL, plan T2); run this where Network runs, or
 * with DATABASE_DIRECT_URL/DATABASE_URL pointing at a copy. A pair is imported only when Network has never
 * seen it: an existing row (blocked, or unblocked since) is the person's later decision and is left alone.
 * Pairs naming an unknown account, a guest or the same person twice are skipped and counted. Each import is
 * a normal block (server/identity/blocks.js setBlock): revision 1 and network.block.changed in
 * network_event_outbox in the same transaction; the running server relays those rows within its next poll.
 * Safe to run twice (the second run imports nothing). Undo a pair with DELETE /api/v1/me/blocks/:subject
 * as the person.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { initDb } = require('../server/db/database');
const blocks = require('../server/identity/blocks');

const USAGE = 'usage: node scripts/import-blocks.js --file <json> [--apply]';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/** --flag / --key value parsing (scripts/lib/db-ops.js keeps the shared one; this stays standalone). */
function parseArgs(argv, { flags = [], values = [] } = {}) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const name = a.replace(/^--/, '');
        if (flags.includes(name)) out[name] = true;
        else if (values.includes(name)) {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
            out[name] = v;
        } else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`unknown argument ${a}`);
    }
    return out;
}

function readPairs(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : data && Array.isArray(data.pairs) ? data.pairs : null;
    if (!list) throw new Error('the file must hold { pairs: [...] } or an array of { blocker_subject, blocked_subject }');
    return list;
}

/** Sort each pair into import / skip. → { todo: [{ blocker, blocked }], skipped: { reason: n } } */
async function plan(db, pairs) {
    const person = db.prepare('SELECT is_anon FROM users WHERE subject_id = ?');
    const seen = db.prepare('SELECT 1 FROM user_blocks WHERE blocker_subject = ? AND blocked_subject = ?');
    const todo = [];
    const skipped = {};
    const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
    const dup = new Set();
    for (const p of pairs) {
        const blocker = p && String(p.blocker_subject || '');
        const blocked = p && String(p.blocked_subject || '');
        if (!SUBJECT_RE.test(blocker) || !SUBJECT_RE.test(blocked)) { skip('not-a-subject'); continue; }
        if (blocker === blocked) { skip('self'); continue; }
        const key = `${blocker}>${blocked}`;
        if (dup.has(key)) { skip('duplicate-in-file'); continue; }
        dup.add(key);
        const a = await person.get(blocker);
        const b = await person.get(blocked);
        if (!a || !b) { skip('unknown-account'); continue; }
        if (a.is_anon || b.is_anon) { skip('guest'); continue; }
        if (await seen.get(blocker, blocked)) { skip('already-on-network'); continue; }
        todo.push({ blocker, blocked });
    }
    return { todo, skipped };
}

async function main(argv, log = console.log) {
    let args;
    try { args = parseArgs(argv, { flags: ['apply'], values: ['file'] }); } catch (e) { log(`${e.message}\n${USAGE}`); return 2; }
    if (args.help) { log(USAGE); return 0; }
    if (!args.file) { log(USAGE); return 2; }
    let pairs;
    try { pairs = readPairs(path.resolve(process.cwd(), args.file)); } catch (e) { log(`error: ${e.message}`); return 2; }
    const db = await initDb();
    await blocks.ensureSchema(db);
    const { todo, skipped } = await plan(db, pairs);
    const why = Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    log(`database   ${db.store}\npairs      ${pairs.length}; to import ${todo.length}; skipped: ${why}`);
    if (!args.apply) { log(todo.length ? 'dry run: nothing changed. Re-run with --apply to import.' : 'nothing to import.'); return 0; }
    let imported = 0;
    let refused = 0;
    for (const p of todo) {
        try { if ((await blocks.setBlock(db, p.blocker, p.blocked, true)).changed) imported++; } catch (e) {
            if (!(e instanceof blocks.BlockError)) throw e;
            refused++;
            log(`refused    ${p.blocker} -> ${p.blocked}: ${e.message}`);
        }
    }
    log(`imported   ${imported} block(s); ${imported} network.block.changed event(s) queued in network_event_outbox${refused ? `; refused ${refused}` : ''}`);
    return refused ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`error: ${err.message}`); process.exit(1); });

module.exports = { main, plan, readPairs };
