'use strict';
// ═══════════════════════════════════════════════════════════════
// OAuth refresh tokens (roadmap §18.2(2)): stored as a hash, rotated on every use, one family per
// sign-in, and a reused token revokes its whole family.
//
//   oauth_tokens.token        'sha256:<hex>' of the token; the token itself is never stored. Tokens
//                             are 48 random bytes (96 hex characters), so an unsalted SHA-256 is enough.
//   oauth_tokens.family_id    every token rotated from the same sign-in shares it
//   oauth_tokens.generation   0 for the token a sign-in issued, +1 per rotation
//   oauth_tokens.revoked_reason  'rotated' (replaced by the next generation) or 'reuse' (the family
//                             was revoked because a rotated token was presented again)
//
// Reuse: presenting a token that was already rotated means two parties hold it (one of them is not the
// client), so every live token of the family is revoked and both have to sign in again. A token
// presented again within REUSE_GRACE_S of its own rotation is refused WITHOUT revoking the family:
// that is two tabs of one browser refreshing at once through Live's cookie, not a replay.
//
// Rows written before this module existed hold the raw token. They keep working: find() matches a raw
// row too and hashes it on first use. scripts/hash-refresh-tokens.js hashes the rest in place (one-way,
// batched, with a backup), so no raw token has to wait for its next use. ensureSchema() at boot only adds
// columns; it changes no data.
// ═══════════════════════════════════════════════════════════════
const crypto = require('crypto');

const PREFIX = 'sha256:';
const RAW_RE = /^[0-9a-f]{96}$/;
const REUSE_GRACE_S = 10;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hash = (token) => PREFIX + crypto.createHash('sha256').update(String(token)).digest('hex');
const newFamily = () => `fam_${crypto.randomBytes(12).toString('hex')}`;
const at = (v) => (v ? new Date(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? '' : 'Z')).getTime() : NaN);

/** Columns and index (boot, idempotent). No data is changed here. */
function ensureSchema(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(oauth_tokens)').all().map(c => c.name));
    if (!cols.has('family_id')) db.exec('ALTER TABLE oauth_tokens ADD COLUMN family_id TEXT');
    if (!cols.has('generation')) db.exec('ALTER TABLE oauth_tokens ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    if (!cols.has('revoked_reason')) db.exec('ALTER TABLE oauth_tokens ADD COLUMN revoked_reason TEXT');
    if (!cols.has('revoked_at')) db.exec('ALTER TABLE oauth_tokens ADD COLUMN revoked_at DATETIME');
    db.exec('CREATE INDEX IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens(family_id)');
}

const LEGACY_WHERE = `substr(token, 1, ${PREFIX.length}) <> '${PREFIX}'`;

/** How many rows still hold a raw token. */
function countLegacy(db) {
    return db.prepare(`SELECT COUNT(*) AS n FROM oauth_tokens WHERE ${LEGACY_WHERE}`).get().n;
}

/**
 * Replace every raw token by its SHA-256, in place (same row), one-way; a row without a family becomes
 * its own. Batched transactions; idempotent. Returns the number of rows hashed.
 */
function hashLegacy(db, { batch = 5000 } = {}) {
    const pick = db.prepare(`SELECT id, token FROM oauth_tokens WHERE ${LEGACY_WHERE} LIMIT ?`);
    const up = db.prepare('UPDATE oauth_tokens SET token = ?, family_id = COALESCE(family_id, ?) WHERE id = ? AND token = ?');
    let n = 0;
    for (;;) {
        const rows = pick.all(batch);
        if (!rows.length) break;
        db.transaction(() => { for (const r of rows) n += up.run(hash(r.token), `fam_legacy_${r.id}`, r.id, r.token).changes; })();
    }
    return n;
}

/** Store a new refresh token; returns the token (the only time it exists in clear). */
function issue(db, { clientId, userId, scope = 'profile theme', familyId = null, generation = 0, now = Date.now() }) {
    const token = crypto.randomBytes(48).toString('hex');
    db.prepare(`INSERT INTO oauth_tokens (token, client_id, user_id, scope, expires_at, family_id, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(hash(token), clientId, userId, scope, new Date(now + TTL_MS).toISOString(), familyId || newFamily(), generation);
    return token;
}

/** The stored row for a presented token, or null. Never matches a stored hash presented as a token. */
function find(db, presented) {
    const raw = String(presented || '');
    if (!RAW_RE.test(raw)) return null;
    const row = db.prepare('SELECT * FROM oauth_tokens WHERE token = ?').get(hash(raw));
    if (row) return row;
    // A row still holding the raw token (written before this change, not yet hashed by
    // scripts/hash-refresh-tokens.js): hash it now, then use it.
    const legacy = db.prepare('SELECT * FROM oauth_tokens WHERE token = ?').get(raw);
    if (!legacy) return null;
    db.prepare('UPDATE oauth_tokens SET token = ?, family_id = COALESCE(family_id, ?) WHERE id = ? AND token = ?').run(hash(raw), `fam_legacy_${legacy.id}`, legacy.id, raw);
    return db.prepare('SELECT * FROM oauth_tokens WHERE id = ?').get(legacy.id);
}

/** Revoke every live token of a family; returns how many. */
function revokeFamily(db, familyId, reason = 'reuse') {
    if (!familyId) return 0;
    return db.prepare("UPDATE oauth_tokens SET revoked = 1, revoked_reason = ?, revoked_at = CURRENT_TIMESTAMP WHERE family_id = ? AND revoked = 0").run(reason, familyId).changes;
}

function audit(db, row, details) {
    try {
        db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(row.user_id, 'oauth_refresh_reuse', JSON.stringify({ client_id: row.client_id, family_id: row.family_id, ...details }));
    } catch { /* audit is best effort */ }
}

/**
 * Validate a presented refresh token for `clientId` and rotate it. Returns
 *   { ok: true, row, familyId, generation }   the caller issues generation `generation` in `familyId`
 *   { ok: false, error: 'invalid_grant', description, reuse? }
 * The old token is revoked ('rotated') atomically: of two concurrent uses exactly one gets ok.
 */
function rotate(db, presented, clientId, { now = Date.now() } = {}) {
    const row = find(db, presented);
    const bad = (description, extra = {}) => ({ ok: false, error: 'invalid_grant', description, ...extra });
    if (!row) return bad('Invalid refresh token');
    if (row.client_id !== clientId) return bad('Client mismatch');
    if (row.revoked) {
        if (row.revoked_reason === 'rotated' && now - at(row.revoked_at) <= REUSE_GRACE_S * 1000) return bad('Refresh token already used');
        const current = db.prepare('SELECT MAX(generation) AS g FROM oauth_tokens WHERE family_id = ?').get(row.family_id).g;
        const n = revokeFamily(db, row.family_id, 'reuse');
        if (row.revoked_reason === 'rotated' || n) audit(db, row, { generation_presented: row.generation, generation_current: current, revoked: n });
        return bad('Refresh token revoked', { reuse: row.revoked_reason === 'rotated' });
    }
    if (now > at(row.expires_at)) return bad('Refresh token expired');
    const won = db.prepare("UPDATE oauth_tokens SET revoked = 1, revoked_reason = 'rotated', revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked = 0").run(row.id).changes === 1;
    if (!won) return bad('Refresh token already used');   // a concurrent use of the same token got it
    return { ok: true, row, familyId: row.family_id || `fam_legacy_${row.id}`, generation: (row.generation || 0) + 1 };
}

module.exports = { ensureSchema, countLegacy, hashLegacy, issue, find, rotate, revokeFamily, hash, PREFIX, REUSE_GRACE_S, TTL_MS };
