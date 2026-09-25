#!/usr/bin/env node
/**
 * Import blocks made elsewhere into platform blocks (roadmap WS-E task 5). The input is the JSON file
 * OpenVibe.Chat's scripts/migrate-dm-blocks-to-network.js writes from its dm_blocks table:
 *
 *   { "pairs": [{ "blocker_subject": "usr_…", "blocked_subject": "usr_…" }, …] }   (a bare array works too)
 *
 *   node scripts/import-blocks.js --file <json>            # dry run: what would be imported, nothing changes
 *   node scripts/import-blocks.js --file <json> --apply    # insert the blocks and queue their events
 *   --db <path>   default $DB_PATH, else data/network.db (relative to the repo root)
 *
 * A pair is imported only when Network has never seen it: an existing row (blocked, or unblocked since)
 * is the person's later decision and is left alone. Pairs naming an unknown account, a guest or the same
 * person twice are skipped and counted. Each import is a normal block (server/identity/blocks.js setBlock):
 * revision 1 and network.block.changed in network_event_outbox in the same transaction; the running
 * server relays those rows within its next poll. Safe to run twice (the second run imports nothing).
 * Safe while Network runs (busy_timeout 5 s). Run as the database's owner; run as root it becomes
 * that owner before opening the database. Undo a pair with DELETE /api/v1/me/blocks/:subject as the person.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const ops = require('./lib/db-ops');
const blocks = require('../server/identity/blocks');

const USAGE = 'usage: node scripts/import-blocks.js --file <json> [--apply] [--db <path>]';
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function readPairs(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : data && Array.isArray(data.pairs) ? data.pairs : null;
    if (!list) throw new Error('the file must hold { pairs: [...] } or an array of { blocker_subject, blocked_subject }');
    return list;
}

/** Sort each pair into import / skip. → { todo: [{ blocker, blocked }], skipped: { reason: n } } */
function plan(db, pairs) {
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
        const a = person.get(blocker);
        const b = person.get(blocked);
        if (!a || !b) { skip('unknown-account'); continue; }
        if (a.is_anon || b.is_anon) { skip('guest'); continue; }
        if (seen.get(blocker, blocked)) { skip('already-on-network'); continue; }
        todo.push({ blocker, blocked });
    }
    return { todo, skipped };
}

async function main(argv, log = console.log) {
    let args;
    try { args = ops.parseArgs(argv, { flags: ['apply'], values: ['db', 'file'] }); } catch (e) { log(`${e.message}\n${USAGE}`); return 2; }
    if (args.help) { log(USAGE); return 0; }
    if (!args.file) { log(USAGE); return 2; }
    const file = ops.dbPath(args);
    if (!fs.existsSync(file)) { log(`error: no database at ${file}`); return 2; }
    let pairs;
    try { pairs = readPairs(path.resolve(process.cwd(), args.file)); } catch (e) { log(`error: ${e.message}`); return 2; }
    ops.dropToOwnerOf(file, log);
    const db = new Database(file);
    db.pragma('busy_timeout = 5000');
    try {
        blocks.ensureSchema(db);
        const { todo, skipped } = plan(db, pairs);
        const why = Object.entries(skipped).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
        log(`database   ${file}\npairs      ${pairs.length}; to import ${todo.length}; skipped: ${why}`);
        if (!args.apply) { log(todo.length ? 'dry run: nothing changed. Re-run with --apply to import.' : 'nothing to import.'); return 0; }
        let imported = 0;
        let refused = 0;
        for (const p of todo) {
            try { if (blocks.setBlock(db, p.blocker, p.blocked, true).changed) imported++; } catch (e) {
                if (!(e instanceof blocks.BlockError)) throw e;
                refused++;
                log(`refused    ${p.blocker} -> ${p.blocked}: ${e.message}`);
            }
        }
        log(`imported   ${imported} block(s); ${imported} network.block.changed event(s) queued in network_event_outbox${refused ? `; refused ${refused}` : ''}`);
        return refused ? 1 : 0;
    } finally { db.close(); }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(`error: ${err.message}`); process.exit(1); });

module.exports = { main, plan, readPairs };
