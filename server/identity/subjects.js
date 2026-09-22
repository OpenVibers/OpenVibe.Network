'use strict';
/**
 * Canonical subjects (roadmap Wave 1, ADR-001; contract identity.subject-ref@1).
 *
 * Every Network account gets a stable `subject_id` (usr_<ULID>) and every anonymous session a
 * `gst_<ULID>`. They are added ALONGSIDE the integer ids, which stay the primary keys and stay in
 * tokens as `sub`/`id`; nothing that reads those today changes.
 *
 * identity_legacy_map links service-local ids (Live's users.id, Media's user_id, Games players, ...)
 * to a subject, so a service can ask "who is live user 123?" without calling Live. A row is never
 * repointed to a different subject: a conflicting write is reported, not applied.
 */
const { ids, validate } = require('openvibe-contracts');

const SELF = 'network';

/** SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) -> ms, so backfilled ULIDs sort by account age. */
function createdMs(value) {
    const t = value ? Date.parse(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z')) : NaN;
    return Number.isFinite(t) ? t : Date.now();
}

function ensureSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS identity_legacy_map (
            source_system TEXT NOT NULL,
            source_type   TEXT NOT NULL,
            source_id     TEXT NOT NULL,
            subject_id    TEXT NOT NULL,
            first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            verified_at   DATETIME,
            metadata      TEXT,
            PRIMARY KEY (source_system, source_type, source_id)
        );
        CREATE INDEX IF NOT EXISTS idx_identity_legacy_subject ON identity_legacy_map(subject_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_subject_id ON users(subject_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_anon_users_subject_id ON anon_users(subject_id);
    `);
    const filled = backfill(db);
    const seeded = seedLegacyMap(db);
    if (filled.users || filled.guests || seeded) {
        console.log(`[Identity] subject ids: ${filled.users} users, ${filled.guests} guests assigned; ${seeded} legacy map rows seeded`);
    }
}

/** Give every row without a subject id one. Idempotent; runs at boot. */
function backfill(db) {
    const out = { users: 0, guests: 0 };
    const run = db.transaction(() => {
        for (const [table, kind, key, born] of [['users', 'user', 'users', 'created_at'], ['anon_users', 'guest', 'guests', 'first_seen']]) {
            const rows = db.prepare(`SELECT id, ${born} AS created_at FROM ${table} WHERE subject_id IS NULL`).all();
            const set = db.prepare(`UPDATE ${table} SET subject_id = ? WHERE id = ? AND subject_id IS NULL`);
            for (const r of rows) out[key] += set.run(ids.newId(kind, createdMs(r.created_at)), r.id).changes;
        }
    });
    run();
    return out;
}

/**
 * Seed the map from what Network already knows: its own ids (so resolution is uniform) and the
 * Live ids of accounts migrated from Live (users.legacy_source/legacy_id).
 */
function seedLegacyMap(db) {
    const ins = db.prepare(`INSERT OR IGNORE INTO identity_legacy_map (source_system, source_type, source_id, subject_id, verified_at)
                            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`);
    let n = 0;
    db.transaction(() => {
        for (const u of db.prepare('SELECT id, subject_id, legacy_source, legacy_id FROM users WHERE subject_id IS NOT NULL').all()) {
            n += ins.run(SELF, 'user', String(u.id), u.subject_id).changes;
            if (u.legacy_source && u.legacy_id != null) n += ins.run(String(u.legacy_source), 'user', String(u.legacy_id), u.subject_id).changes;
        }
        for (const g of db.prepare('SELECT id, subject_id FROM anon_users WHERE subject_id IS NOT NULL').all()) {
            n += ins.run(SELF, 'anon_user', String(g.id), g.subject_id).changes;
        }
    })();
    return n;
}

/** Subject id for a users row, assigning one if an insert path skipped it. */
function ensureUserSubject(db, user) {
    if (!user) return null;
    if (user.subject_id) return user.subject_id;
    const row = db.prepare('SELECT subject_id, created_at FROM users WHERE id = ?').get(user.id);
    if (!row) return null;
    if (!row.subject_id) {
        const sid = ids.newId('user', createdMs(row.created_at));
        db.prepare('UPDATE users SET subject_id = ? WHERE id = ? AND subject_id IS NULL').run(sid, user.id);
        db.prepare(`INSERT OR IGNORE INTO identity_legacy_map (source_system, source_type, source_id, subject_id, verified_at)
                    VALUES (?, 'user', ?, ?, CURRENT_TIMESTAMP)`).run(SELF, String(user.id), sid);
        row.subject_id = db.prepare('SELECT subject_id FROM users WHERE id = ?').get(user.id).subject_id;
    }
    user.subject_id = row.subject_id;
    return row.subject_id;
}

/** New subject id for an insert: `INSERT INTO users (..., subject_id) VALUES (..., newUserSubjectId())`. */
const newUserSubjectId = () => ids.newId('user');
const newGuestSubjectId = () => ids.newId('guest');

/** Public projection of a subject. Never includes email, role internals or secrets. */
function projection(db, subjectId) {
    if (typeof subjectId !== 'string') return null;
    if (subjectId.startsWith('usr_')) {
        const u = db.prepare('SELECT id, subject_id, username, display_name, avatar_url, is_banned FROM users WHERE subject_id = ?').get(subjectId);
        if (!u) return null;
        return { subject: { type: 'user', id: u.subject_id }, network_user_id: u.id, username: u.username,
            display_name: u.display_name || u.username, avatar_url: u.avatar_url || null, banned: Boolean(u.is_banned) };
    }
    if (subjectId.startsWith('gst_')) {
        const g = db.prepare('SELECT id, subject_id, anon_number, display_name FROM anon_users WHERE subject_id = ?').get(subjectId);
        if (!g) return null;
        return { subject: { type: 'guest', id: g.subject_id }, network_anon_id: g.id, username: `anon${g.anon_number}`,
            display_name: g.display_name || `anon${g.anon_number}`, avatar_url: null, banned: false };
    }
    return null;
}

/** Resolve by subject id or by (system, type, id). Returns the projection plus the matching legacy ids. */
function resolve(db, { subject_id, source_system, source_type, source_id }) {
    let sid = subject_id;
    if (!sid) {
        if (source_system === SELF && source_type === 'user') {
            const u = db.prepare('SELECT id, subject_id, created_at FROM users WHERE id = ?').get(Number(source_id));
            sid = u ? ensureUserSubject(db, u) : null;
        } else {
            const row = db.prepare('SELECT subject_id FROM identity_legacy_map WHERE source_system = ? AND source_type = ? AND source_id = ?')
                .get(String(source_system), String(source_type || 'user'), String(source_id));
            sid = row && row.subject_id;
        }
    }
    const p = sid ? projection(db, sid) : null;
    if (!p) return null;
    p.legacy_ids = db.prepare('SELECT source_system, source_type, source_id FROM identity_legacy_map WHERE subject_id = ? ORDER BY source_system, source_type')
        .all(p.subject.id);
    return p;
}

/**
 * Record service-local ids for existing subjects. Each entry names the Network account either by
 * `subject_id` or `network_user_id` (what services store today). Rows for source_system 'network'
 * are refused: Network is the authority for its own ids.
 * Returns { inserted, unchanged, conflicts: [...], rejected: [...] }.
 */
function upsertLegacy(db, entries) {
    const out = { inserted: 0, unchanged: 0, conflicts: [], rejected: [] };
    const get = db.prepare('SELECT subject_id FROM identity_legacy_map WHERE source_system = ? AND source_type = ? AND source_id = ?');
    const ins = db.prepare(`INSERT INTO identity_legacy_map (source_system, source_type, source_id, subject_id, verified_at, metadata)
                            VALUES (?, ?, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP END, ?)`);
    const byNetworkId = db.prepare('SELECT id, subject_id, created_at FROM users WHERE id = ?');
    db.transaction(() => {
        entries.forEach((e, i) => {
            let subjectId = e.subject_id;
            if (!subjectId && e.network_user_id != null) {
                const u = byNetworkId.get(Number(e.network_user_id));
                subjectId = u ? ensureUserSubject(db, u) : null;
            }
            const row = { subject_id: subjectId, source_system: e.source_system, source_type: e.source_type || 'user', source_id: e.source_id == null ? '' : String(e.source_id) };
            const v = validate('identity.legacy-identity-map@1', row);
            if (!subjectId || !v.valid || row.source_system === SELF || !projection(db, subjectId)) {
                out.rejected.push({ index: i, reason: !subjectId ? 'unknown network account' : row.source_system === SELF ? 'network ids are not writable' : !v.valid ? v.errors.map(x => `${x.path} ${x.message}`).join('; ') : 'unknown subject' });
                return;
            }
            const existing = get.get(row.source_system, row.source_type, row.source_id);
            if (existing) {
                if (existing.subject_id === subjectId) out.unchanged++;
                else out.conflicts.push({ index: i, source: `${row.source_system}:${row.source_type}:${row.source_id}`, mapped_to: existing.subject_id, requested: subjectId });
                return;
            }
            ins.run(row.source_system, row.source_type, row.source_id, subjectId, e.verified ? 1 : 0, e.metadata ? JSON.stringify(e.metadata) : null);
            out.inserted++;
        });
    })();
    return out;
}

module.exports = { ensureSchema, backfill, seedLegacyMap, ensureUserSubject, newUserSubjectId, newGuestSubjectId, projection, resolve, upsertLegacy, createdMs };
