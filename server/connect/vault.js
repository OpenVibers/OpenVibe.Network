'use strict';
/**
 * The vault (Compute plan E7): a person's own credentials for the apps their agents act in.
 *
 *   store(db, subject, app, label, value, { scopes, config })   -> the credential row (metadata only)
 *   open(db, subject, app, label, { config })                    -> the plaintext, for the one call that uses it
 *   list(db, subject)                                           -> every credential: app, label, scopes, when
 *   revoke(db, subject, app, label)                             -> the credential is gone (the row goes too)
 *   exportFor(db, subject)                                      -> the apps, never the secrets
 *   eraseFor(db, subject)                                       -> every credential of this person, gone
 *
 * Sealing: AES-256-GCM under a key derived from Network's KEK (NETWORK_SECRETS_KEY, the same key D11's
 * sealed project secrets use), with the person's subject and the app as the authenticated data. A
 * ciphertext copied onto another row (another person, another app) does not open. The plaintext is
 * decrypted only inside the gateway, for the one request that carries it, and is never written to a
 * page, a log, an error message or a response.
 *
 * Without the key the feature is off (503 connect.vault_unavailable), never plaintext.
 */
const crypto = require('crypto');
const { newId } = require('./ids');

const MAX_VALUE_BYTES = 8192;
const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY_ID = 'k1';
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** The keys, derived once per configured secret: { id, enc }, or null when NETWORK_SECRETS_KEY is unset or malformed. */
const keyCache = new Map();
function keyring(config) {
    const raw = String((config && config.secrets && config.secrets.key) || '').trim();
    if (!raw) return null;
    if (keyCache.has(raw)) return keyCache.get(raw);
    const bytes = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    const kr = bytes.length === 32 ? {
        id: KEY_ID,
        enc: Buffer.from(crypto.hkdfSync('sha256', bytes, Buffer.alloc(0), 'openvibe-network connect credential sealing', 32)),
    } : null;
    keyCache.set(raw, kr);
    return kr;
}

class VaultError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail || code; }
}
const fail = (status, code, detail) => { throw new VaultError(status, code, detail); };

function requireKeys(config) {
    const kr = keyring(config);
    if (!kr) fail(503, 'connect.vault_unavailable', 'the credential vault is not configured on this Network (NETWORK_SECRETS_KEY)');
    return kr;
}

/** The authenticated data: the person's subject and the app (and the row's own id). */
const aadOf = (subject, app, id) => Buffer.from(`${subject}\n${app}\n${id}`, 'utf8');

function seal(kr, subject, app, id, value) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', kr.enc, iv);
    c.setAAD(aadOf(subject, app, id));
    const ciphertext = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

/** The plaintext, or null when the row cannot be opened (wrong subject, wrong app, a copied ciphertext). */
function openSealed(kr, row) {
    if (!row || !row.ciphertext || row.key_id !== kr.id) return null;
    try {
        const d = crypto.createDecipheriv('aes-256-gcm', kr.enc, Buffer.from(row.iv, 'base64'));
        d.setAAD(aadOf(row.subject, row.app, row.id));
        d.setAuthTag(Buffer.from(row.tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(row.ciphertext, 'base64')), d.final()]).toString('utf8');
    } catch {
        return null;   // a wrong subject, a wrong app, or a tampered row: nothing comes out
    }
}

const nowIso = () => new Date().toISOString();

function cleanLabel(label) {
    const l = String(label == null ? 'default' : label).trim().toLowerCase();
    if (!LABEL_RE.test(l)) fail(422, 'connect.invalid_label', 'a label is 1-64 characters: a lowercase letter or digit, then letters, digits, dots, dashes or underscores');
    return l;
}
function cleanValue(value) {
    if (typeof value !== 'string' || !value.length) fail(422, 'connect.invalid_credential', 'the credential is a non-empty string');
    const v = value.trim();
    if (Buffer.byteLength(v, 'utf8') > MAX_VALUE_BYTES) fail(422, 'connect.credential_too_large', `a credential is at most ${MAX_VALUE_BYTES} bytes`);
    if (CONTROL_RE.test(v)) fail(422, 'connect.invalid_credential', 'the credential must not contain control characters');
    return v;
}

/** The metadata of one credential: never the secret. */
function view(row) {
    let scopes = [];
    try { scopes = JSON.parse(row.scopes || '[]'); } catch { scopes = []; }
    return {
        id: row.id, app: row.app, label: row.label, scopes: Array.isArray(scopes) ? scopes : [],
        created_at: row.created_at, last_used_at: row.last_used_at || null,
    };
}

/**
 * Store a credential. The caller has already made the test call: a credential the test call refuses is
 * never stored (the walkthrough asks first, and only a credential that works is kept).
 */
async function store(db, subject, app, label, value, { scopes = [], config } = {}) {
    const kr = requireKeys(config);
    const v = cleanValue(value);
    const l = cleanLabel(label);
    const id = newId('cvd');
    const sealed = seal(kr, subject, app, id, v);
    const at = nowIso();
    await db.prepare(`INSERT INTO connect_credentials (id, subject, app, label, scopes, key_id, iv, tag, ciphertext, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT (subject, app, label) DO UPDATE SET id = excluded.id, key_id = excluded.key_id, iv = excluded.iv, tag = excluded.tag,
                        ciphertext = excluded.ciphertext, scopes = excluded.scopes, created_at = excluded.created_at, revoked_at = NULL`)
        .run(id, subject, app, l, JSON.stringify(Array.isArray(scopes) ? scopes.map(String) : []), kr.id, sealed.iv, sealed.tag, sealed.ciphertext, at);
    const row = await db.prepare('SELECT * FROM connect_credentials WHERE subject = ? AND app = ? AND label = ?').get(subject, app, l);
    return view(row);
}

/** The plaintext of one credential, for the one request that uses it. */
async function openCredential(db, subject, app, label, { config } = {}) {
    const kr = requireKeys(config);
    const row = await db.prepare('SELECT * FROM connect_credentials WHERE subject = ? AND app = ? AND label = ? AND revoked_at IS NULL')
        .get(subject, app, cleanLabel(label));
    if (!row) return null;
    const value = openSealed(kr, row);
    if (value == null) fail(503, 'connect.vault_unavailable', 'this credential cannot be opened with the configured key');
    return value;
}

/** Every credential of this person: app, label, scopes, when it was added and when it was last used. */
async function list(db, subject) {
    const rows = await db.prepare('SELECT * FROM connect_credentials WHERE subject = ? AND revoked_at IS NULL ORDER BY app, label').all(subject);
    return rows.map(view);
}

/** The apps this person has a credential for (the export lists the apps, never the secrets). */
async function exportFor(db, subject) {
    const rows = await db.prepare('SELECT DISTINCT app FROM connect_credentials WHERE subject = ? AND revoked_at IS NULL ORDER BY app').all(subject);
    return rows.map((r) => r.app);
}

/** Take one credential away: the row goes, so the sealed value is gone too. */
async function revoke(db, subject, app, label) {
    const r = await db.prepare('DELETE FROM connect_credentials WHERE subject = ? AND app = ? AND label = ?')
        .run(subject, app, cleanLabel(label));
    if (!r.changes) fail(404, 'connect.not_found', 'no such credential');
    return { revoked: true };
}

/** Every credential of this person, gone (the account lifecycle: deletion erases). */
async function eraseFor(db, subject) {
    const r = await db.prepare('DELETE FROM connect_credentials WHERE subject = ?').run(subject);
    return { erased: r.changes || 0 };
}

/** Note that a credential was used (the listing shows when it was last used). */
async function touch(db, id, at = nowIso()) {
    await db.prepare('UPDATE connect_credentials SET last_used_at = ? WHERE id = ?').run(at, id);
}

module.exports = {
    store, open: openCredential, list, revoke, exportFor, eraseFor, touch,
    keyring, seal, openSealed, view, VaultError, MAX_VALUE_BYTES,
};
