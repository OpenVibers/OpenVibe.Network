'use strict';
/**
 * Network's site settings as revisioned configuration (roadmap WS-C task 7; openvibe-shared/config).
 *
 * `site_settings` stays what everything reads: db getSetting (environment first for managed secrets,
 * server/secrets.js, then the typed row) is unchanged. The namespace `network.site_settings` is the
 * journal of changes to those rows:
 *   - an admin change (PUT /api/admin/settings, /api/admin/email, /api/admin/discord) is one revision,
 *     recorded with who made it and why, and written to the rows from the revision (only the keys it
 *     changes; a row keeps its type, and a new row takes the type its caller gave);
 *   - history and rollback come with it (GET /api/admin/config…, POST …/rollback, owner only);
 *   - secret-class values (type `secret` rows, API keys, tokens, secrets) are only ever shown as keyed
 *     fingerprints.
 * Rows written around the journal (a migration, an older code path) are recorded as a "sync" revision
 * before the next change, so a change or a rollback never reverts them.
 *
 * Not configuration, never in the namespace (NOT_CONFIG): one-off migration flags, and the generated
 * push key pair (vapid_*), which a rollback must never swap.
 */
const config = require('openvibe-shared/config');

const NOT_CONFIG = /^(migr_|vapid_)/;
const SECRET = /(api[_-]?key|secret|token|password|private[_-]?key|access_key)/i;
const PUBLIC_KEYS = new Set(['platform_name', 'registration_open', 'default_theme']);
const SYSTEM = { type: 'service', id: 'network' };
const byDb = new WeakMap();

const isConfigKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= 100 && !NOT_CONFIG.test(key);

/** The journal for one database handle. */
function forDb(db) {
    if (byDb.has(db)) return byDb.get(db);
    const types = new Map();      // key → the row type last seen (a rollback that re-creates a row reuses it)
    const secretRows = new Set(); // keys stored with type 'secret'

    function rowsNow() {
        const out = {};
        for (const r of db.prepare('SELECT key, value, type FROM site_settings').all()) {
            if (!isConfigKey(r.key)) continue;
            out[r.key] = r.value == null ? '' : String(r.value);
            types.set(r.key, r.type || 'string');
            if (r.type === 'secret') secretRows.add(r.key);
        }
        return out;
    }
    const classify = (key) => (secretRows.has(key) || SECRET.test(key) ? 'secret' : PUBLIC_KEYS.has(key) ? 'public' : 'internal');

    let pendingTypes = {};        // the types the change being applied names for new rows
    function writeRows(target) {
        const now = rowsNow();
        const upd = db.prepare('UPDATE site_settings SET value = ? WHERE key = ?');
        const ins = db.prepare('INSERT INTO site_settings (key, value, type) VALUES (?, ?, ?)');
        const del = db.prepare('DELETE FROM site_settings WHERE key = ?');
        db.transaction(() => {
            for (const [k, v] of Object.entries(target)) {
                if (!isConfigKey(k)) continue;
                if (!(k in now)) ins.run(k, String(v), pendingTypes[k] || types.get(k) || 'string');
                else if (now[k] !== String(v)) upd.run(String(v), k);
            }
            for (const k of Object.keys(now)) if (!(k in target)) del.run(k);
        })();
    }

    rowsNow();   // learn the types and secret rows before the store classifies anything
    const store = config.createConfigStore({
        db, service: 'network', namespace: 'network.site_settings',
        classify,
        legacy: () => rowsNow(),
        onActivate: async (values) => writeRows(values),
        log: { info: (m) => console.log(`[Config] ${m}`), warn: (m) => console.warn(`[Config] ${m}`), error: (m) => console.error(`[Config] ${m}`) },
    });
    const canonical = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

    /** Record rows written around the journal as a revision of their own. → the sync snapshot, or null */
    async function sync() {
        const now = rowsNow();
        if (canonical({ ...store.get() }) === canonical(now)) return null;
        return store.apply(now, { actor: SYSTEM, reason: 'sync: site_settings changed outside the configuration journal' });
    }

    /** Change settings as one revision: set (key → value), types (key → row type for new rows), unset (keys). */
    async function change({ set = {}, unset = [], types: t = {} } = {}, { actor = SYSTEM, reason = null } = {}) {
        const bad = [...Object.keys(set), ...unset].filter((k) => !isConfigKey(k));
        if (bad.length) throw Object.assign(new Error(`not configuration: ${bad.join(', ')}`), { status: 400, code: 'config.not_configuration' });
        await sync();
        for (const [k, ty] of Object.entries(t)) if (ty === 'secret') secretRows.add(k);
        const values = {};
        for (const [k, v] of Object.entries(set)) values[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
        pendingTypes = t;
        try { return await store.apply(values, { merge: true, unset, actor, reason }); } finally { pendingTypes = {}; }
    }

    async function rollback({ actor = SYSTEM, reason = null, to } = {}) {
        await sync();
        return store.rollback({ actor, reason, to });
    }

    const out = { store, change, rollback, sync, isConfigKey };
    byDb.set(db, out);
    return out;
}

/** A person as the journal records them. */
function actorOf(user) {
    return user && user.subject_id ? { type: 'user', id: String(user.subject_id) } : SYSTEM;
}

module.exports = { forDb, actorOf, isConfigKey, NOT_CONFIG };
