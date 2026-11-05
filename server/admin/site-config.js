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
const secrets = require('../secrets');

const NOT_CONFIG = /^(migr_|vapid_)/;
const SECRET = /(api[_-]?key|secret|token|password|private[_-]?key|access_key)/i;
const PUBLIC_KEYS = new Set(['platform_name', 'registration_open', 'default_theme']);
const SYSTEM = { type: 'service', id: 'network' };
const byDb = new WeakMap();

const isConfigKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= 100 && !NOT_CONFIG.test(key);
const isSecret = (key) => SECRET.test(key) || secrets.isSecret(key);

/** The journal for one database handle. */
async function forDb(db) {
    if (byDb.has(db)) return byDb.get(db);
    const types = new Map();      // key → the row type last seen (a rollback that re-creates a row reuses it)
    const secretRows = new Set(); // keys stored with type 'secret'

    async function rowsNow() {
        const out = {};
        for (const r of await db.prepare('SELECT key, value, type FROM site_settings').all()) {
            if (!isConfigKey(r.key)) continue;
            out[r.key] = r.value == null ? '' : String(r.value);
            types.set(r.key, r.type || 'string');
            if (r.type === 'secret') secretRows.add(r.key);
        }
        return out;
    }
    const classify = (key) => (secretRows.has(key) || SECRET.test(key) ? 'secret' : PUBLIC_KEYS.has(key) ? 'public' : 'internal');

    let pendingTypes = {};        // the types the change being applied names for new rows
    const isSecretRow = (k) => SECRET.test(k) || secretRows.has(k) || secrets.isSecret(k);
    async function writeRows(target) {
        const now = await rowsNow();
        const upd = db.prepare('UPDATE site_settings SET value = ? WHERE key = ?');
        const ins = db.prepare('INSERT INTO site_settings (key, value, type) VALUES (?, ?, ?)');
        const del = db.prepare('DELETE FROM site_settings WHERE key = ?');
        await db.tx(async () => {
            for (const [k, v] of Object.entries(target)) {
                if (!isConfigKey(k)) continue;
                // D11: a secret-class value never goes into site_settings; its row may stay as a blank, typed slot.
                if (isSecretRow(k)) {
                    if (!(k in now)) await ins.run(k, '', pendingTypes[k] || types.get(k) || 'string');
                    continue;
                }
                if (!(k in now)) await ins.run(k, String(v), pendingTypes[k] || types.get(k) || 'string');
                else if (now[k] !== String(v)) await upd.run(String(v), k);
            }
            for (const k of Object.keys(now)) if (!(k in target) && !isSecretRow(k)) await del.run(k);
        });
    }

    const initial = await rowsNow();   // learn the types and secret rows before the store classifies anything
    const store = await config.createConfigStore({
        db, service: 'network', namespace: 'network.site_settings',
        classify,
        // The legacy source is snapshotted now (an object, not a callback): the revision it seeds is the rows
        // as they are at boot.
        legacy: initial,
        onActivate: async (values) => await writeRows(values),
        log: { info: (m) => console.log(`[Config] ${m}`), warn: (m) => console.warn(`[Config] ${m}`), error: (m) => console.error(`[Config] ${m}`) },
    });
    const canonical = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
    const nonSecret = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !isSecretRow(k)));

    /** Record non-secret rows written around the journal as a revision of their own. → the sync snapshot, or null */
    async function sync() {
        const now = await rowsNow();
        const current = { ...store.get() };
        const next = {};
        for (const [k, v] of Object.entries(current)) if (isSecretRow(k)) next[k] = v;   // secrets stay in the store
        for (const [k, v] of Object.entries(now)) if (!isSecretRow(k)) next[k] = v;
        if (canonical(nonSecret(current)) === canonical(nonSecret(next))) return null;
        return store.apply(next, { actor: SYSTEM, reason: 'sync: site_settings changed outside the configuration journal' });
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
        try {
            const snap = await store.apply(values, { merge: true, unset, actor, reason });
            // An explicit unset drops the store's secret; blank its legacy slot too (env-only provider secrets
            // are never touched: their row is ignored and the environment is the source).
            for (const k of unset) if (isSecretRow(k) && !secrets.isSecret(k)) await db.prepare('UPDATE site_settings SET value = ? WHERE key = ?').run('', k);
            return snap;
        } finally { pendingTypes = {}; }
    }

    async function rollback({ actor = SYSTEM, reason = null, to } = {}) {
        await sync();
        return store.rollback({ actor, reason, to });
    }

    const out = { store, change, rollback, sync, isConfigKey };
    byDb.set(db, out);
    return out;
}

/** The value of a secret-class key from a loaded journal, without touching the legacy row. */
function readSecret(db, key) {
    const out = byDb.get(db);
    if (!out) return undefined;
    if (out.store.classify(key, undefined) !== 'secret') return undefined;
    return out.store.get(key);
}

/**
 * D11: with a KEK, every secret-class row the sealed store holds is blanked (read-back and marker must agree).
 * A provider secret managed by server/secrets.js is environment-only: never moved, never blanked. Without a KEK
 * nothing is blanked; without a sealed copy, or with a locked envelope, the row is kept. Counts only.
 */
async function migrateLegacySecrets(db, out) {
    const rows = await db.prepare('SELECT key, value, type FROM site_settings').all();
    // Only configuration rows: keys the journal never holds (NOT_CONFIG: the VAPID pair, migration markers) have no
    // sealed copy to prove against, and are not counted.
    const candidates = rows.filter((r) => r.value != null && String(r.value) !== '' && isConfigKey(r.key)
        && (r.type === 'secret' || SECRET.test(r.key)) && !secrets.isSecret(r.key));
    if (!candidates.length) return { checked: 0, blanked: 0, differs: 0, kept: 0, sealed: !!out.store.sealed };
    if (!out.store.sealed) {
        console.log(`[Config] legacy site_settings: ${candidates.length} secret value(s) left (no KEK; the store is not sealed)`);
        return { checked: candidates.length, blanked: 0, differs: 0, kept: candidates.length, sealed: false };
    }
    const summary = await out.store.summary();
    const snap = summary.active;
    const upd = db.prepare('UPDATE site_settings SET value = ? WHERE key = ?');
    let blanked = 0, differs = 0;
    for (const r of candidates) {
        const stored = out.store.get(r.key);
        const marker = summary.secrets[r.key] || (typeof out.store.secretMarker === 'function' ? await out.store.secretMarker(r.key) : null);
        const sealedRow = snap && snap.values ? snap.values[r.key] : null;
        const proven = stored !== undefined && stored !== null && String(stored) !== ''
            && marker && sealedRow && sealedRow.redacted === true
            && marker.fingerprint && marker.fingerprint === sealedRow.fingerprint;
        // Never drop a value the store does not hold: the sealed copy must be exactly this legacy value.
        if (!proven || String(stored) !== String(r.value)) { differs++; continue; }
        await upd.run('', r.key);
        blanked++;
    }
    console.log(`[Config] legacy site_settings: ${blanked} secret value(s) blanked (the store holds the same value); ${differs} kept (value differs or no sealed copy)${out.store.kek ? `; KEK ${out.store.kek}` : ''}`);
    return { checked: candidates.length, blanked, differs, kept: differs, sealed: true };
}

let boot = null;
/** Boot: load the journal, seal old plaintext rows, then blank the legacy copies the sealed store holds. */
function init(db) {
    if (boot) return boot;
    boot = (async () => {
        const out = await forDb(db);
        if (out.store.sealed) await out.store.reseal();
        return await migrateLegacySecrets(db, out);
    })().catch((err) => { boot = null; throw err; });
    return boot;
}

/** A person as the journal records them. */
function actorOf(user) {
    return user && user.subject_id ? { type: 'user', id: String(user.subject_id) } : SYSTEM;
}

module.exports = { forDb, init, readSecret, migrateLegacySecrets, isSecret, actorOf, isConfigKey, NOT_CONFIG };
