'use strict';
/**
 * The callers: who may act for a person, and what they may do in which app.
 *
 *   person    the person themselves (their session token, on the Apps page)
 *   key       a key the person made on the Apps page for one caller of their own (their Claude Code,
 *             a script on their laptop). Only the hash of the key is kept; the key itself is shown
 *             once, at the moment it is made.
 *   service   a service acting for the person (Codes, Actor): its token names the person in
 *             on_behalf_of, and the caller is the service.
 *
 * A grant is per caller and per app: none, read, or read and write. A send, delete or pay action
 * asks again whatever the grant says (server/connect/approvals.js).
 */
const crypto = require('crypto');
const { newId } = require('./ids');

const LEVELS = ['read', 'write'];
const KEY_PREFIX = 'ovc_';

const nowIso = () => new Date().toISOString();
const hash = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

class ConnectError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail || code; }
}
const fail = (status, code, detail) => { throw new ConnectError(status, code, detail); };

/** The caller's row as the Apps page shows it: never a key, only its hash and its prefix. */
function view(row) {
    if (!row) return null;
    return {
        id: row.id, kind: row.kind, name: row.name, created_at: row.created_at,
        last_used_at: row.last_used_at || null, revoked_at: row.revoked_at || null,
        token_prefix: row.token_prefix || null,
    };
}

/** The person themselves: one row per person, made on first use. */
async function ensurePersonCaller(db, subject, name = 'You') {
    const id = `per_${hash(subject).slice(0, 32)}`;
    const row = await db.prepare('SELECT * FROM connect_callers WHERE id = ?').get(id);
    if (row) return row;
    await db.prepare(`INSERT INTO connect_callers (id, subject, kind, name, created_at) VALUES (?, ?, 'person', ?, ?)
                      ON CONFLICT (id) DO NOTHING`).run(id, subject, String(name || 'You').slice(0, 100), nowIso());
    return await db.prepare('SELECT * FROM connect_callers WHERE id = ?').get(id);
}

/** A service acting for the person: one row per service, made on first use. */
async function ensureServiceCaller(db, subject, service, name) {
    const id = `svc_${String(service || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40).toLowerCase()}`;
    const row = await db.prepare('SELECT * FROM connect_callers WHERE id = ?').get(id);
    if (row) return row;
    await db.prepare(`INSERT INTO connect_callers (id, subject, kind, name, created_at) VALUES (?, ?, 'service', ?, ?)
                      ON CONFLICT (id) DO NOTHING`).run(id, subject, String(name || service || 'A service').slice(0, 100), nowIso());
    return await db.prepare('SELECT * FROM connect_callers WHERE id = ?').get(id);
}

/**
 * Make a key for one caller of the person's own. The key is returned once; only its hash is kept.
 * → { caller, key }
 */
async function createKeyCaller(db, subject, name) {
    const label = String(name || '').trim();
    if (!label || label.length > 100) fail(422, 'connect.invalid_caller', 'the caller needs a name of 1-100 characters');
    const id = newId('cal');
    const secret = crypto.randomBytes(24).toString('base64url');
    const key = `${KEY_PREFIX}${id}_${secret}`;
    await db.prepare(`INSERT INTO connect_callers (id, subject, kind, name, token_hash, token_prefix, created_at)
                      VALUES (?, ?, 'key', ?, ?, ?, ?)`)
        .run(id, subject, label, hash(secret), secret.slice(0, 6), nowIso());
    return { caller: view(await db.prepare('SELECT * FROM connect_callers WHERE id = ?').get(id)), key };
}

/** The caller a personal key belongs to, or null. The key is compared by hash, in constant time. */
async function findByKey(db, token) {
    const raw = String(token || '');
    if (!raw.startsWith(KEY_PREFIX)) return null;
    // The key is ovc_<caller id>_<secret>; the secret may hold an underscore, so the split is the last one.
    const rest = raw.slice(KEY_PREFIX.length);
    const cut = rest.lastIndexOf('_');
    if (cut <= 0) return null;
    const id = rest.slice(0, cut);
    const secret = rest.slice(cut + 1);
    const row = await db.prepare('SELECT * FROM connect_callers WHERE id = ? AND kind = \'key\' AND revoked_at IS NULL').get(id);
    if (!row || !row.token_hash) return null;
    const given = Buffer.from(hash(secret), 'hex');
    const known = Buffer.from(String(row.token_hash), 'hex');
    if (given.length !== known.length || !crypto.timingSafeEqual(given, known)) return null;
    return row;
}

/** Note that a caller was used. */
async function touch(db, id) {
    await db.prepare('UPDATE connect_callers SET last_used_at = ? WHERE id = ?').run(nowIso(), id);
}

/** Every caller of this person, with its grants. */
async function listCallers(db, subject) {
    const rows = await db.prepare('SELECT * FROM connect_callers WHERE subject = ? ORDER BY kind, name').all(subject);
    const out = [];
    for (const row of rows) {
        const grants = await db.prepare('SELECT app, level FROM connect_grants WHERE caller_id = ? ORDER BY app').all(row.id);
        out.push({ ...view(row), grants: Object.fromEntries(grants.map((g) => [g.app, g.level])) });
    }
    return out;
}

/** What one caller may do in one app: 'read', 'write', or null (nothing). */
async function grantOf(db, callerId, app) {
    const row = await db.prepare('SELECT level FROM connect_grants WHERE caller_id = ? AND app = ?').get(callerId, app);
    return row ? row.level : null;
}

/** Every grant of one caller, as a map. */
async function grantsOf(db, callerId) {
    const rows = await db.prepare('SELECT app, level FROM connect_grants WHERE caller_id = ?').all(callerId);
    return Object.fromEntries(rows.map((r) => [r.app, r.level]));
}

/** Give a caller a grant (read or write), or take it away (null). */
async function setGrant(db, callerId, app, level, subject) {
    const appKey = String(app || '');
    if (!/^[a-z][a-z0-9_]*$/.test(appKey)) fail(422, 'connect.invalid_app', 'that is not an app in the catalogue');
    if (level === null || level === undefined || level === '') {
        await db.prepare('DELETE FROM connect_grants WHERE caller_id = ? AND app = ?').run(callerId, appKey);
        return {};
    }
    if (!LEVELS.includes(level)) fail(422, 'connect.invalid_grant', 'a grant is read or write');
    // A grant is only for an app this person has connected.
    const has = await db.prepare('SELECT 1 AS ok FROM connect_credentials WHERE subject = ? AND app = ? AND revoked_at IS NULL LIMIT 1')
        .get(String(subject), appKey);
    if (!has) fail(409, 'connect.not_connected', 'connect that app first');
    const at = nowIso();
    await db.prepare(`INSERT INTO connect_grants (caller_id, app, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT (caller_id, app) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`)
        .run(callerId, appKey, level, at, at);
    return grantsOf(db, callerId);
}

/** Take a caller away: its grants go with it (the table cascades). */
async function revokeCaller(db, callerId) {
    await db.prepare('DELETE FROM connect_grants WHERE caller_id = ?').run(callerId);
    const r = await db.prepare('DELETE FROM connect_callers WHERE id = ?').run(callerId);
    if (!r.changes) fail(404, 'connect.not_found', 'no such caller');
    return { revoked: true };
}

module.exports = {
    ensurePersonCaller, ensureServiceCaller, createKeyCaller, findByKey, touch, listCallers,
    grantOf, grantsOf, setGrant, revokeCaller, view, ConnectError, LEVELS, KEY_PREFIX,
};
