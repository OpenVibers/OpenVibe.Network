#!/usr/bin/env node
'use strict';
/**
 * A repeatable rehearsal of the T2 PostgreSQL cutover (docs/cutover-t2-postgres.md), end to end on scratch
 * stores: the SQLite database → pg-preflight → migrate-to-postgres → row-count parity → the server booted on
 * the result, /api/ready green. Nothing outside a temporary directory (and, on the containers, a database of
 * its own, dropped at the end) is written; the SQLite file is only ever opened read-only.
 *
 *   npm run rehearse-pg-cutover                                   a seeded database with commit 20dd7ff's schema
 *   npm run rehearse-pg-cutover -- --sqlite /path/to/copy.db      a real snapshot (a copy, never the live file)
 *   node scripts/rehearse-pg-cutover.js --write-fixture <file>    only write the seeded SQLite database, then exit
 *
 *   --store auto|pglite|containers|env  where the PostgreSQL side lives (default auto: containers, else pglite;
 *                   auto never uses inherited DATABASE_URLs)
 *       env         only when given explicitly. DATABASE_DIRECT_URL + DATABASE_URL: a scratch database you made for
 *                   this. Both must reach that same database (a probe table made through one is read through the
 *                   other) and it must be empty through both. The import empties every Network table there, so
 *                   a target where any table already holds a row is refused unless --truncate-target is given.
 *                   Never point it at the production database.
 *       containers  openvibe-sdk's test services (eval "$(node_modules/openvibe-sdk/scripts/test-services.sh up)"):
 *                   OV_TEST_PG_DIRECT_URL. A throwaway database network_rehearsal_* with roles shaped like
 *                   production's: the owner migrates and imports, a DML-only role (statement_timeout 15 s) serves.
 *                   A database, not a schema in the shared one: an import reads information_schema, which the
 *                   shared test database's thousands of test schemas slow past the 15 s query cap. The container
 *                   PgBouncer routes only that shared database, so here the server connects directly (npm run
 *                   test:pg covers serving through PgBouncer). OV_TEST_VALKEY_URL, when set, backs the limit
 *                   counters under a prefix of its own.
 *       pglite      an embedded PGlite directory: nothing to set up.
 *   --keep          keep the temporary directory (its path is in the JSON line as "dir")
 *
 * On PostgreSQL the import is the real `node scripts/migrate-to-postgres.js --sqlite <file>` with the target's
 * DATABASE_DIRECT_URL. PGlite has no URL, so there the script runs as its own --pglite dry run and the same
 * import (its importInto: migrations, TABLES, SKIP_SOURCE, QUIET_TRIGGERS) fills the PGlite directory the
 * server then boots on. On PostgreSQL the server boots with NODE_ENV=production (DATABASE_URL required, the
 * RS256 signing key required); on PGlite with NODE_ENV=test (production refuses PGlite). Either way /api/ready
 * must answer 200 with `db` and `signing_key` ok.
 *
 * Progress goes to stderr. The last line on stdout is one JSON object, counts only, never a row:
 *   {"ok":true,"tables":{"users":{"sqlite":6,"pg":6},…},"ready":{"ready":true,"status":…,"db":"ok","signing_key":"ok"},…}
 * Exit 0 only when ok: preflight clean, import verified, every table's count equal, and ready.
 */
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseArgs, ROOT } = require('./lib/db-ops');

const FIXTURE_SCHEMA = path.join(__dirname, 'fixtures', 'network-sqlite-20dd7ff.sql');
const MIGRATIONS = path.join(ROOT, 'migrations');
const log = (...a) => console.error('[rehearse]', ...a);

// ── The seeded database ──────────────────────────────────────
// Commit 20dd7ff's schema (scripts/fixtures/network-sqlite-20dd7ff.sql) with rows shaped like production's:
// accounts (mixed-case names, an anonymous and a banned one), OAuth clients/codes/token families, notifications
// (JSON rich content, one message holding a NUL that PostgreSQL refuses), the wallet ledger, legacy and
// subject follows, blocks, sessions, an unsent outbox event, the profile changes 20dd7ff's users_profile_created
// trigger writes, an old per-IP rate counter. SQLite CURRENT_TIMESTAMP text throughout.
const SUBJECT = (n) => `usr_rehearsal${String(n).padStart(4, '0')}`;
function seedFixture(file) {
    const Database = require('better-sqlite3');
    const db = new Database(file);
    db.pragma('foreign_keys = ON');
    db.exec(fs.readFileSync(FIXTURE_SCHEMA, 'utf8'));
    const ins = (table, rows) => {
        const cols = Object.keys(rows[0]);
        const st = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
        for (const r of rows) st.run(r);
    };
    const at = (d, h = 12) => `2026-0${d}-1${d} ${String(h).padStart(2, '0')}:0${d}:3${d}`;
    const hash = (n) => `$2a$10$rehearsalfixturehashnotarealpasswordhash${String(n).padStart(13, '0')}`;
    // Opaque token strings, generated per run: the fixture holds row shapes, not credentials.
    const rtToken = (family, gen) => `rt-family-${family}-gen${gen}-${crypto.randomBytes(8).toString('hex')}`;
    db.transaction(() => {
        ins('users', [
            { id: 1, username: 'alex', email: 'alex@example.test', password_hash: hash(1), display_name: 'Alex', role: 'admin', email_verified: 1, email_verified_at: at(1), subject_id: SUBJECT(1), created_at: at(1), updated_at: at(2), last_seen: at(3), is_anon: 0, history_paused: 0, is_banned: 0, ban_reason: null, anon_number: null },
            { id: 2, username: 'Bea_Streams', email: 'bea@example.test', password_hash: hash(2), display_name: 'Bea ✨ Streams', role: 'streamer', email_verified: 1, email_verified_at: at(1), subject_id: SUBJECT(2), created_at: at(1), updated_at: at(1), last_seen: at(4), is_anon: 0, history_paused: 1, is_banned: 0, ban_reason: null, anon_number: null },
            { id: 3, username: 'carol', email: null, password_hash: hash(3), display_name: null, role: 'user', email_verified: 0, email_verified_at: null, subject_id: SUBJECT(3), created_at: at(2), updated_at: at(2), last_seen: null, is_anon: 0, history_paused: 0, is_banned: 0, ban_reason: null, anon_number: null },
            { id: 4, username: 'DanTheMod', email: 'dan@example.test', password_hash: hash(4), display_name: 'Dan', role: 'global_mod', email_verified: 1, email_verified_at: at(2), subject_id: SUBJECT(4), created_at: at(2), updated_at: at(3), last_seen: at(5), is_anon: 0, history_paused: 0, is_banned: 0, ban_reason: null, anon_number: null },
            { id: 5, username: 'spam_account', email: 'spam@example.test', password_hash: hash(5), display_name: 'Spam', role: 'user', email_verified: 0, email_verified_at: null, subject_id: SUBJECT(5), created_at: at(3), updated_at: at(3), last_seen: at(3), is_anon: 0, history_paused: 0, is_banned: 1, ban_reason: 'spam', anon_number: null },
            { id: 6, username: 'anon_7', email: null, password_hash: hash(6), display_name: 'Anon #7', role: 'user', email_verified: 0, email_verified_at: null, subject_id: SUBJECT(6), created_at: at(4), updated_at: at(4), last_seen: at(4), is_anon: 1, history_paused: 0, is_banned: 0, ban_reason: null, anon_number: 7 },
        ]);
        ins('oauth_clients', [
            { client_id: 'live', client_secret: 'rehearsal-client-secret-live', name: 'OpenVibe.Live', redirect_uris: '["https://openvibe.live/auth/callback"]', is_first_party: 1, created_at: at(1) },
            { client_id: 'chat', client_secret: 'rehearsal-client-secret-chat', name: 'OpenVibe.Chat', redirect_uris: '["https://openvibe.chat/auth/callback"]', is_first_party: 1, created_at: at(1) },
        ]);
        ins('oauth_codes', [
            { code: 'code-used-1', client_id: 'live', user_id: 2, redirect_uri: 'https://openvibe.live/auth/callback', scope: 'openid profile', expires_at: at(4, 13), used: 1, code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', nonce: 'n-1', created_at: at(4) },
            { code: 'code-open-2', client_id: 'chat', user_id: 3, redirect_uri: 'https://openvibe.chat/auth/callback', scope: 'openid', expires_at: at(5, 13), used: 0, code_challenge: null, code_challenge_method: null, nonce: null, created_at: at(5) },
        ]);
        ins('oauth_tokens', [
            { id: 1, token: rtToken('a', 1), client_id: 'live', user_id: 2, scope: 'openid profile', expires_at: at(9), revoked: 1, family_id: 'fam-a', generation: 1, revoked_reason: 'rotated', revoked_at: at(5), created_at: at(4) },
            { id: 2, token: rtToken('a', 2), client_id: 'live', user_id: 2, scope: 'openid profile', expires_at: at(9), revoked: 0, family_id: 'fam-a', generation: 2, revoked_reason: null, revoked_at: null, created_at: at(5) },
            { id: 3, token: rtToken('b', 1), client_id: 'chat', user_id: 1, scope: 'openid', expires_at: at(9), revoked: 0, family_id: 'fam-b', generation: 1, revoked_reason: null, revoked_at: null, created_at: at(5) },
        ]);
        ins('user_preferences', [
            { user_id: 1, theme_id: 'midnight', custom_theme_variables: '{"--accent":"#8b5cf6"}', language: 'en', notifications_enabled: 1, display_prefs: '{"compact":true,"motion":"reduce"}', updated_at: at(2) },
            { user_id: 2, theme_id: null, custom_theme_variables: null, language: 'fr', notifications_enabled: 0, display_prefs: null, updated_at: at(3) },
        ]);
        ins('notifications', [
            { id: 'ntf-0001', user_id: 1, type: 'follow', category: 'social', priority: 'normal', title: 'Bea followed you', message: 'Say hi!', sender_id: 2, sender_name: 'Bea', service: 'network', url: '/u/Bea_Streams', rich_content: '{"actor":{"subject":"usr_rehearsal0002"}}', is_read: 1, is_dismissed: 0, is_emailed: 0, expires_at: null, created_at: at(5) },
            { id: 'ntf-0002', user_id: 1, type: 'live', category: 'streams', priority: 'high', title: 'Bea is live', message: 'Speedrun night', sender_id: 2, sender_name: 'Bea', service: 'live', url: 'https://openvibe.live/Bea_Streams', rich_content: null, is_read: 0, is_dismissed: 0, is_emailed: 1, expires_at: at(9), created_at: at(6) },
            { id: 'ntf-0003', user_id: 2, type: 'system', category: 'system', priority: 'normal', title: 'Welcome', message: 'legacy text with a NUL here:\u0000end', sender_id: null, sender_name: null, service: 'network', url: null, rich_content: '{"steps":["profile","theme"]}', is_read: 0, is_dismissed: 1, is_emailed: 0, expires_at: null, created_at: at(4) },
            { id: 'ntf-0004', user_id: 3, type: 'coins', category: 'wallet', priority: 'low', title: 'You received 50 OpenCoins', message: null, sender_id: null, sender_name: null, service: 'network', url: '/wallet', rich_content: null, is_read: 0, is_dismissed: 0, is_emailed: 0, expires_at: null, created_at: at(6) },
            { id: 'ntf-0005', user_id: 4, type: 'moderation', category: 'moderation', priority: 'high', title: 'Report resolved', message: 'Thanks', sender_id: null, sender_name: null, service: 'community', url: null, rich_content: null, is_read: 1, is_dismissed: 0, is_emailed: 0, expires_at: null, created_at: at(7) },
        ]);
        ins('notification_preferences', [
            { user_id: 1, category: 'social', enabled: 1, sound: 0, toasts: 1, email: 0 },
            { user_id: 1, category: 'streams', enabled: 1, sound: 1, toasts: 1, email: 1 },
            { user_id: 2, category: 'social', enabled: 0, sound: 0, toasts: 0, email: 0 },
        ]);
        ins('user_sessions', [
            { id: 1, user_id: 1, session_token: 'sess-rehearsal-1', device_name: 'Firefox on Linux', ip: null, user_agent: null, is_active: 1, last_used: at(6), created_at: at(5), expires_at: at(9) },
            { id: 2, user_id: 2, session_token: 'sess-rehearsal-2', device_name: 'Phone', ip: null, user_agent: null, is_active: 0, last_used: at(5), created_at: at(4), expires_at: at(8) },
        ]);
        ins('linked_accounts', [{ id: 1, user_id: 2, service: 'twitch', service_user_id: '424242', service_username: 'bea_streams', linked_at: at(3), last_used_at: at(5) }]);
        ins('verification_keys', [
            { id: 1, key: 'vk-rehearsal-1', target_username: 'ReservedName', note: 'creator reservation', created_by: 1, used_by: null, status: 'active', created_at: at(3), used_at: null },
            { id: 2, key: 'vk-rehearsal-2', target_username: 'Bea_Streams', note: null, created_by: 1, used_by: 2, status: 'used', created_at: at(1), used_at: at(1) },
        ]);
        ins('anon_users', [{ id: 1, anon_number: 7, fingerprint: 'fp-rehearsal', session_token: 'anon-sess-7', display_name: 'Anon #7', preferences: '{"color":"#ff0"}', total_messages: 12, total_commands: 1, first_seen: at(4), last_seen: at(5), ip: null, subject_id: 'anon_rehearsal0007' }]);
        // The wallet ledger: balances are the sum of each account's transactions.
        ins('coin_transactions', [
            { id: 1, user_id: 1, app_id: 'network', delta: 100, reason: 'signup_bonus', ref: null, idempotency_key: 'signup:1', created_at: at(1) },
            { id: 2, user_id: 2, app_id: 'network', delta: 100, reason: 'signup_bonus', ref: null, idempotency_key: 'signup:2', created_at: at(1) },
            { id: 3, user_id: 3, app_id: 'network', delta: 100, reason: 'signup_bonus', ref: null, idempotency_key: 'signup:3', created_at: at(2) },
            { id: 4, user_id: 2, app_id: 'live', delta: -50, reason: 'tip', ref: 'tip:ntf-0004', idempotency_key: 'tip:2:3:1', created_at: at(6) },
            { id: 5, user_id: 3, app_id: 'live', delta: 50, reason: 'tip_received', ref: 'tip:ntf-0004', idempotency_key: 'tip:2:3:1:recv', created_at: at(6) },
            { id: 6, user_id: 1, app_id: 'games', delta: -25, reason: 'purchase', ref: 'item:hat', idempotency_key: null, created_at: at(7) },
        ]);
        ins('wallets', [
            { user_id: 1, balance: 75, updated_at: at(7) },
            { user_id: 2, balance: 50, updated_at: at(6) },
            { user_id: 3, balance: 150, updated_at: at(6) },
        ]);
        ins('follows', [
            { follower_id: 1, followed_id: 2, created_at: at(4) },
            { follower_id: 3, followed_id: 2, created_at: at(5) },
            { follower_id: 2, followed_id: 1, created_at: at(5) },
        ]);
        ins('user_follows', [
            { follower_subject: SUBJECT(1), target_type: 'channel', target_id: SUBJECT(2), active: 1, notify_email: 1, notify_push: 0, revision: 1, source: 'live', created_at: '2026-04-14T12:00:00.000Z', updated_at: '2026-04-14T12:00:00.000Z' },
            { follower_subject: SUBJECT(3), target_type: 'channel', target_id: SUBJECT(2), active: 1, notify_email: 0, notify_push: 1, revision: 2, source: 'network', created_at: '2026-05-15T12:00:00.000Z', updated_at: '2026-05-16T08:00:00.000Z' },
            { follower_subject: SUBJECT(4), target_type: 'channel', target_id: SUBJECT(2), active: 0, notify_email: 1, notify_push: 1, revision: 3, source: 'network', created_at: '2026-05-15T12:00:00.000Z', updated_at: '2026-06-01T08:00:00.000Z' },
        ]);
        ins('user_blocks', [
            { blocker_subject: SUBJECT(2), blocked_subject: SUBJECT(5), active: 1, revision: 1, created_at: '2026-05-01T10:00:00.000Z', updated_at: '2026-05-01T10:00:00.000Z' },
            { blocker_subject: SUBJECT(1), blocked_subject: SUBJECT(5), active: 0, revision: 2, created_at: '2026-05-01T10:00:00.000Z', updated_at: '2026-05-02T10:00:00.000Z' },
        ]);
        ins('audit_log', [{ id: 1, user_id: 1, action: 'user.ban', details: '{"target":5,"reason":"spam"}', ip: null, created_at: at(3) }]);
        ins('site_settings', [{ key: 'registration_open', value: 'true', type: 'boolean' }]);
        // Left behind by the import (SKIP_SOURCE): per-IP counters, never carried over.
        ins('analytics_rate_tracking', [{ ip: '198.51.100.7', window_start: 1767268800, hit_count: 3 }]);
        ins('network_event_outbox', [{ id: 1, event_id: 'evt-rehearsal-1', envelope: '{"type":"network.user.updated","subject":"usr_rehearsal0002"}', traceparent: null, created_at: 1767268800000, attempts: 2, next_attempt_at: 1767268860000, sent_at: null, seq: 1, rejected_at: null, last_error: 'events unreachable' }]);
    })();
    db.close();
}

// ── Helpers ──────────────────────────────────────────────────
function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

/** Run a node script from scripts/ in `cwd` (a directory with no .env) with exactly `env`. → { code, stdout, stderr } */
function runNode(args, { cwd, env }) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        p.stdout.on('data', (d) => { stdout += d; });
        p.stderr.on('data', (d) => { stderr += d; });
        p.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

/** The first JSON object a script printed (they pretty-print it), or null. */
function jsonOf(text) {
    const i = text.indexOf('{');
    if (i < 0) return null;
    try { return JSON.parse(text.slice(i)); } catch { return null; }
}

/** A URL with its password masked, for the log. */
const masked = (url) => { try { const u = new URL(url); if (u.password) u.password = '***'; return u.toString(); } catch { return '(unparseable url)'; } };

/**
 * --store env's guard, before anything is imported. `direct` (DATABASE_DIRECT_URL, the import's connection) and
 * `pooled` (DATABASE_URL, the server's) must reach the same database; DATABASE_URL may be a pooler, so host and port
 * prove nothing. The target must be empty through `direct` first (read-only, so a live database is refused before
 * anything is written). Then a probe table with a random name, made through `direct` with a random token as its
 * comment, must show that token through `pooled` (catalogs only, so a DML-only role can read it); the probe is
 * dropped either way. Then the target must be empty through `pooled` too. Throws with a message naming no URL.
 */
async function checkScratchTarget(direct, pooled, { truncateTarget = false } = {}) {
    const assertEmpty = async (name, db) => {
        if (truncateTarget) return;
        // A scratch database holds no rows anywhere (ov_migrations aside): any row means it is not one.
        const tables = (await db.many(`SELECT tablename FROM pg_tables
            WHERE schemaname = current_schema() AND tablename <> 'ov_migrations'`)).map((r) => r.tablename);
        const held = [];
        for (const t of tables) if (await db.value(`SELECT EXISTS (SELECT 1 FROM "${t.replace(/"/g, '""')}")`)) held.push(t);
        if (held.length) throw new Error(`the target is not empty through ${name} (rows in ${held.length} table(s): ${held.slice(0, 5).join(', ')}${held.length > 5 ? ', …' : ''}); the import empties it. Give --truncate-target if it really is a scratch database`);
    };
    await assertEmpty('DATABASE_DIRECT_URL', direct);
    const probe = `ov_rehearsal_probe_${crypto.randomBytes(6).toString('hex')}`;
    const token = crypto.randomBytes(16).toString('hex');
    let seen = null;
    try {
        await direct.exec(`CREATE TABLE ${probe} (id int)`);
        await direct.exec(`COMMENT ON TABLE ${probe} IS '${token}'`);
        seen = await pooled.value(`SELECT obj_description(c.oid, 'pg_class') FROM pg_class c WHERE c.relname = '${probe}'`)
            .catch((e) => { throw new Error(`reading the probe through DATABASE_URL failed: ${e.message}`); });
    } finally {
        await direct.exec(`DROP TABLE IF EXISTS ${probe}`).catch((e) => log(`probe cleanup: ${e.message}`));
    }
    if (seen !== token) throw new Error('DATABASE_URL does not reach the database DATABASE_DIRECT_URL imports into (a probe table made through DATABASE_DIRECT_URL is not visible through DATABASE_URL); --store env needs both on one scratch database');
    await assertEmpty('DATABASE_URL', pooled);
}

/** The PostgreSQL side: { store, directUrl?, url?, pgliteDir?, valkeyUrl?, close() }. */
async function openTarget(store, dir, truncateTarget) {
    if (store === 'env') {
        const directUrl = (process.env.DATABASE_DIRECT_URL || '').trim(), url = (process.env.DATABASE_URL || '').trim();
        if (!directUrl || !url) throw new Error(`--store env needs DATABASE_DIRECT_URL and DATABASE_URL, both on one scratch database (${directUrl ? 'DATABASE_URL' : 'DATABASE_DIRECT_URL'} is unset or empty)`);
        const { createDb } = require('openvibe-sdk/db');
        const silent = { log() {}, warn() {}, error() {} };
        const direct = createDb({ url: directUrl, service: 'network-rehearsal', max: 1, log: silent });
        const pooled = createDb({ url, service: 'network-rehearsal-pooled', max: 1, log: silent });
        try { await checkScratchTarget(direct, pooled, { truncateTarget }); }
        finally { await Promise.allSettled([direct.close(), pooled.close()]); }
        log(`target: DATABASE_DIRECT_URL ${masked(directUrl)}, DATABASE_URL ${masked(url)} (the same database)`);
        return { store: 'postgresql', directUrl, url, valkeyUrl: process.env.VALKEY_URL || null, close: async () => {} };
    }
    if (store === 'containers') {
        if (!process.env.OV_TEST_PG_DIRECT_URL) throw new Error('--store containers needs OV_TEST_PG_DIRECT_URL (eval "$(node_modules/openvibe-sdk/scripts/test-services.sh up)")');
        return scratchDatabase(process.env.OV_TEST_PG_DIRECT_URL);
    }
    const pgliteDir = path.join(dir, 'pglite');
    log(`target: PGlite ${pgliteDir}`);
    return { store: 'pglite', pgliteDir, valkeyUrl: null, close: async () => {} };
}

/**
 * A database of its own on the containers' PostgreSQL (`superUrl`, a superuser on a direct connection), shaped as
 * OpenVibe.Host's roles/data/add-service.sh makes production's: an owner role owning the database and its public
 * schema (migrations, the import) and a runtime role with DML only. close() drops the database and both roles.
 */
async function scratchDatabase(superUrl) {
    const { createDb } = require('openvibe-sdk/db');
    const silent = { log() {}, warn() {}, error() {} };
    const name = `network_rehearsal_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
    const owner = `${name}_owner`;
    const pw = crypto.randomBytes(16).toString('hex');
    const as = (user, db = name) => { const u = new URL(superUrl); u.username = user; u.password = pw; u.pathname = `/${db}`; return u.toString(); };
    // DROP DATABASE … WITH (FORCE) on the shared, busy container can outlast the 15 s default cap.
    const su = createDb({ url: superUrl, service: 'network-rehearsal-admin', max: 1, queryTimeoutMs: 120000, log: silent });
    const drop = async () => {
        await su.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        for (const r of [name, owner]) await su.exec(`DROP ROLE IF EXISTS ${r}`);
    };
    try {
        for (const stmt of [
            `CREATE ROLE ${owner} LOGIN PASSWORD '${pw}'`,
            `CREATE ROLE ${name} LOGIN PASSWORD '${pw}'`,
            `ALTER ROLE ${name} SET statement_timeout = '15s'`,
            `ALTER ROLE ${name} SET lock_timeout = '5s'`,
            `CREATE DATABASE ${name} OWNER ${owner}`,
            `REVOKE ALL ON DATABASE ${name} FROM PUBLIC`,
            `GRANT CONNECT ON DATABASE ${name} TO ${owner}, ${name}`,
        ]) await su.exec(stmt);
        const o = createDb({ url: as(owner), service: 'network-rehearsal-owner', max: 1, log: silent });
        try {
            for (const stmt of [
                `GRANT USAGE ON SCHEMA public TO ${name}`,
                `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${name}`,
                `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${name}`,
            ]) await o.exec(stmt);
        } finally { await o.close(); }
    } catch (e) { await drop().catch(() => {}); await su.close(); throw e; }
    log(`target: test-services container, database ${name}`);
    return {
        store: 'postgresql', directUrl: as(owner), url: as(name), valkeyUrl: process.env.OV_TEST_VALKEY_URL || null,
        close: async () => { try { await drop(); } finally { await su.close(); } },
    };
}

/** PGlite: migrate-to-postgres.js's import, into the directory the server then boots on. */
async function importIntoPglite(sqlite, pgliteDir) {
    const { createDb } = require('openvibe-sdk/db');
    const { importInto } = require('./migrate-to-postgres');
    const owner = createDb({ pglite: pgliteDir, service: 'network-import', log: { log() {}, warn: console.error, error: console.error } });
    try { return await importInto(owner, sqlite); } finally { await owner.close(); }
}

/**
 * GET `${base}/api/ready` until it answers 200 with ready, stop() is true, or timeoutMs passes. Each request, body
 * included, is aborted after min(the time left, requestMs), so a server that accepts and never answers cannot hold
 * the rehearsal past its deadline. → { status, body } of the last answer read (null when none was).
 */
async function pollReady(base, { timeoutMs, stop = () => false, requestMs = 5000 }) {
    const t0 = Date.now();
    let status = null, body = null;
    while (!stop()) {
        const left = timeoutMs - (Date.now() - t0);
        if (left <= 0) break;
        try {
            const r = await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(Math.max(1, Math.min(left, requestMs))) });
            status = r.status;
            body = await r.json();
            if (r.status === 200 && body.ready) break;
        } catch { /* not listening yet, aborted at the deadline, or not JSON */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    return { status, body };
}

/** Boot server/index.js on the target and read /api/ready until it is ready (or the deadline). */
async function bootAndCheck(target, dir, { timeoutMs = 120000 } = {}) {
    const port = await freePort();
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'keys', 'private.pem'), keys.privateKey, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'keys', 'public.pem'), keys.publicKey);
    const env = {
        PATH: process.env.PATH, HOME: dir, PORT: String(port), HOST: '127.0.0.1',
        NODE_ENV: target.store === 'pglite' ? 'test' : 'production',
        JWT_PRIVATE_KEY: path.join(dir, 'keys', 'private.pem'), JWT_PUBLIC_KEY: path.join(dir, 'keys', 'public.pem'),
        AVATAR_PATH: path.join(dir, 'avatars'),
        OV_NETWORK_INTERNAL_URL: `http://127.0.0.1:${port}`,
        OV_LIVE_INTERNAL_URL: 'http://127.0.0.1:9', OV_TOOLS_INTERNAL_URL: 'http://127.0.0.1:9', OV_GAMES_INTERNAL_URL: 'http://127.0.0.1:9',
        OV_MEDIA_INTERNAL_URL: 'http://127.0.0.1:9', OV_AI_INTERNAL_URL: 'http://127.0.0.1:9',
        ...(target.store === 'pglite' ? { PGLITE_DIR: target.pgliteDir } : { DATABASE_URL: target.url, DATABASE_DIRECT_URL: target.directUrl }),
        ...(target.valkeyUrl ? { VALKEY_URL: target.valkeyUrl, VALKEY_PREFIX: `ov:network-rehearsal-${crypto.randomBytes(4).toString('hex')}:` } : {}),
    };
    const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    let exited = null;
    proc.on('exit', (code, sig) => { exited = { code, sig }; });
    const base = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    let body = null, status = null;
    try {
        ({ status, body } = await pollReady(base, { timeoutMs, stop: () => !!exited }));
    } finally {
        if (!exited) {
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 5000);
                proc.once('exit', () => { clearTimeout(timer); resolve(); });
                proc.kill('SIGTERM');
            });
            if (!exited) {
                try { proc.kill('SIGKILL'); } catch { /* gone */ }
                await new Promise((resolve) => { if (exited) resolve(); else proc.once('exit', resolve); });
            }
        }
    }
    const checks = (body && body.checks) || {};
    const ready = {
        http: status, ready: !!(body && body.ready), status: body ? body.status : null,
        db: checks.db ? checks.db.status : null, signing_key: checks.signing_key ? checks.signing_key.status : null,
        failed: body ? body.failed : null, degraded: body ? body.degraded : null, node_env: env.NODE_ENV, valkey: !!target.valkeyUrl, ms: Date.now() - t0,
    };
    ready.ok = status === 200 && ready.ready && ready.db === 'ok' && ready.signing_key === 'ok';
    if (!ready.ok) {
        ready.exited = exited;
        // The boot log's tail, for the operator; the server never logs secrets or rows.
        log(`server did not become ready (${JSON.stringify(exited)}); last log lines:\n${out.split('\n').slice(-25).join('\n')}`);
    }
    return ready;
}

// ── The rehearsal ────────────────────────────────────────────
async function rehearse(opts) {
    const t0 = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-network-rehearsal-'));
    const result = { ok: false, source: opts.sqlite ? 'snapshot' : 'seeded-20dd7ff', store: null, preflight: null, import: null, tables: {}, pg_only: {}, ready: null, problems: [], dir: opts.keep ? dir : undefined };
    // Children get exactly this environment, in a directory with no .env, so nothing else is picked up.
    const childEnv = { PATH: process.env.PATH, HOME: dir };
    let target = null;
    try {
        const sqlite = opts.sqlite ? path.resolve(opts.sqlite) : path.join(dir, 'network.db');
        if (opts.sqlite) { if (!fs.existsSync(sqlite)) throw new Error(`no such SQLite database: ${sqlite}`); }
        else seedFixture(sqlite);
        log(`source: ${sqlite}`);

        // 1. pg-preflight: case-fold collisions block the cutover.
        const pre = await runNode([path.join(__dirname, 'pg-preflight-collisions.js'), '--sqlite', sqlite, '--json'], { cwd: dir, env: childEnv });
        const preReport = jsonOf(pre.stdout);
        result.preflight = { ok: pre.code === 0, exit: pre.code, collisions: preReport ? preReport.collisions.map((c) => ({ table: c.table, column: c.column, spellings: c.spellings })) : null };
        if (pre.code !== 0) { result.problems.push(`pg-preflight exited ${pre.code}${pre.stderr ? `: ${pre.stderr.trim().split('\n').pop()}` : ''}`); return result; }
        log('preflight: no case-fold collisions');

        // 2. migrate-to-postgres into the scratch target.
        const store = opts.store === 'auto'
            ? (process.env.OV_TEST_PG_DIRECT_URL ? 'containers' : 'pglite')
            : opts.store;
        target = await openTarget(store, dir, opts['truncate-target']);
        result.store = target.store;
        let imp;
        if (target.store === 'pglite') {
            const dry = await runNode([path.join(__dirname, 'migrate-to-postgres.js'), '--sqlite', sqlite, '--pglite', '--json'], { cwd: dir, env: childEnv });
            const dryReport = jsonOf(dry.stdout);
            if (dry.code !== 0) result.problems.push(`migrate-to-postgres --pglite exited ${dry.code}: ${dryReport ? JSON.stringify(dryReport.problems) : dry.stderr.trim().split('\n').pop()}`);
            imp = await importIntoPglite(sqlite, target.pgliteDir);
            imp.script = { exit: dry.code };
        } else {
            const run = await runNode([path.join(__dirname, 'migrate-to-postgres.js'), '--sqlite', sqlite, '--json'], { cwd: dir, env: { ...childEnv, DATABASE_DIRECT_URL: target.directUrl } });
            imp = jsonOf(run.stdout) || { ok: false, tables: [], problems: [{ table: '-', problem: run.stderr.trim().split('\n').pop() || `exit ${run.code}` }] };
            imp.script = { exit: run.code };
        }
        result.import = { ok: imp.ok && imp.script.exit === 0, tables: imp.tables.length, rows: imp.tables.reduce((n, t) => n + t.rows, 0), cleaned: imp.cleaned || [], problems: imp.problems };
        if (!result.import.ok) { result.problems.push('migrate-to-postgres did not verify'); return result; }
        log(`import: ${result.import.tables} tables, ${result.import.rows} rows verified`);

        // 3. Row-count parity, before the server's boot seeds anything.
        const { rowParity } = require('./pg-row-parity');
        const { createDb } = require('openvibe-sdk/db');
        const quiet = { log() {}, warn: console.error, error: console.error };
        const src = new (require('better-sqlite3'))(sqlite, { readonly: true, fileMustExist: true });
        const db = target.store === 'pglite' ? createDb({ pglite: target.pgliteDir, service: 'network-parity', log: quiet })
            : createDb({ url: target.directUrl, service: 'network-parity', max: 1, log: quiet });
        let parity;
        try { parity = await rowParity(src, db); } finally { src.close(); await db.close(); }
        result.tables = parity.tables;
        result.pg_only = parity.pg_only;
        for (const p of parity.problems) result.problems.push(`${p.table}: ${p.problem}`);
        if (!parity.ok) return result;
        log(`parity: ${Object.keys(parity.tables).length} tables equal`);

        // 4. The server on the imported database: /api/ready with db and signing_key ok.
        result.ready = await bootAndCheck(target, dir, { timeoutMs: opts.timeoutMs });
        if (!result.ready.ok) result.problems.push(`/api/ready: ${result.ready.http} ${result.ready.status} (failed: ${JSON.stringify(result.ready.failed)})`);
        else log(`ready: ${result.ready.status} in ${result.ready.ms} ms`);
        result.ok = result.preflight.ok && result.import.ok && parity.ok && result.ready.ok && result.problems.length === 0;
        return result;
    } catch (err) {
        result.problems.push(err.message);
        return result;
    } finally {
        if (target) await target.close().catch((e) => log(`cleanup: ${e.message}`));
        if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
        result.ms = Date.now() - t0;
    }
}

async function main(argv = process.argv.slice(2)) {
    let opts;
    try { opts = parseArgs(argv, { flags: ['keep', 'truncate-target'], values: ['sqlite', 'store', 'write-fixture', 'timeout'] }); } catch (e) { console.error(e.message); return 2; }
    if (opts.help) { console.error('usage: node scripts/rehearse-pg-cutover.js [--sqlite <copy.db>] [--store auto|pglite|containers|env] [--truncate-target] [--keep] [--write-fixture <file>]'); return 2; }
    if (opts['write-fixture']) {
        const file = path.resolve(opts['write-fixture']);
        if (fs.existsSync(file)) { console.error(`${file} exists; not overwriting it`); return 2; }
        seedFixture(file);
        console.error(`wrote ${file}`);
        return 0;
    }
    opts.store = opts.store || 'auto';
    if (!['auto', 'pglite', 'containers', 'env'].includes(opts.store)) { console.error(`--store ${opts.store}: auto, pglite, containers or env`); return 2; }
    opts.timeoutMs = opts.timeout ? Number(opts.timeout) * 1000 : 120000;
    const result = await rehearse(opts);
    if (result.dir === undefined) delete result.dir;
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
}

if (require.main === module) main().then((code) => process.exit(code), (err) => { console.log(JSON.stringify({ ok: false, problems: [err.message] })); process.exit(1); });

module.exports = { rehearse, seedFixture, FIXTURE_SCHEMA, checkScratchTarget, pollReady };
