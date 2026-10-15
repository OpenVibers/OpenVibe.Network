'use strict';
/**
 * Project secrets (ADR-056): per project and environment, written once and used by name, never read back.
 *
 *   people (project routes, Bearer user tokens; developer/routes.js)
 *     list             viewer+ and staff: metadata only (network.project-secret@1): name, version, fingerprint, grants
 *     put              admin+ (not staff as such): set or replace the value; the version goes up by one
 *     remove           admin+: the secret and its grants
 *     putGrant         admin+: let one service use it for sign and/or reveal (reveal names the https origins)
 *     removeGrant      admin+
 *   services (POST /internal/secrets/use, network.secret.use; internal/routes.js)
 *     use              sign: HMAC-SHA256 of the message under the secret, the value never leaves; reveal: the value,
 *                      for an origin the grant lists. Anything refused is 404 secret.not_found, so a guess learns nothing.
 *
 * The value is stored only encrypted: AES-256-GCM under a key derived from NETWORK_SECRETS_KEY (32 bytes, base64 or hex)
 * with the row's identity (project, environment, name, version) as authenticated data, so a ciphertext copied onto
 * another row does not open. The fingerprint is a keyed hash (another key derived from the same secret): equal values
 * match, and it reveals nothing else. Without the key the feature is off (503 secrets.unavailable), never plaintext.
 * Archiving a project shreds its secrets (shredProject: the ciphertext, iv and tag are dropped).
 *
 * Audit (dev_audit): every value set, deletion and grant change, and the first use of a secret per service, purpose and
 * UTC day (a grant records when it was last used). Values and messages are never written anywhere else, logs included.
 */
const crypto = require('crypto');
const { validate } = require('openvibe-contracts');
const store = require('./store');

const ENVS = ['sandbox', 'production'];
const PURPOSES = ['sign', 'reveal'];
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;
const MAX_VALUE_BYTES = 8192;
const MAX_PER_ENV = 50;
const MAX_GRANTS = 20;
const MAX_ORIGINS = 10;
const KEY_ID = 'k1';

const { DevError } = store;
const fail = (status, code, detail) => { throw new DevError(status, code, detail); };
const nowIso = () => new Date().toISOString();
const notFound = () => fail(404, 'secret.not_found', 'no such secret for this caller');

/** The keys, derived once per configured secret: { id, enc, fp }, or null when NETWORK_SECRETS_KEY is unset or malformed. */
const keyCache = new Map();
function keyring(config) {
    const raw = String((config && config.secrets && config.secrets.key) || '').trim();
    if (!raw) return null;
    if (keyCache.has(raw)) return keyCache.get(raw);
    const bytes = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    const kr = bytes.length === 32 ? {
        id: KEY_ID,
        enc: Buffer.from(crypto.hkdfSync('sha256', bytes, Buffer.alloc(0), 'openvibe-network project-secret encryption', 32)),
        fp: Buffer.from(crypto.hkdfSync('sha256', bytes, Buffer.alloc(0), 'openvibe-network project-secret fingerprint', 32)),
    } : null;
    keyCache.set(raw, kr);
    return kr;
}
function requireKeys(config) {
    const kr = keyring(config);
    if (!kr) fail(503, 'secrets.unavailable', 'project secrets are not configured on this Network (NETWORK_SECRETS_KEY)');
    return kr;
}

const aadOf = (row) => Buffer.from(`${row.project_id}\n${row.environment}\n${row.name}\n${row.version}`, 'utf8');
function seal(kr, row, value) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', kr.enc, iv);
    c.setAAD(aadOf(row));
    const ciphertext = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function open(kr, row) {
    if (!row.ciphertext || row.key_id !== kr.id) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', kr.enc, Buffer.from(row.iv, 'base64'));
    d.setAAD(aadOf(row));
    d.setAuthTag(Buffer.from(row.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(row.ciphertext, 'base64')), d.final()]).toString('utf8');
}
const fingerprintOf = (kr, value) => crypto.createHmac('sha256', kr.fp).update(value, 'utf8').digest('hex').slice(0, 12);

function cleanEnv(v) { if (!ENVS.includes(v)) fail(422, 'secret.invalid', 'environment is sandbox or production'); return v; }
function cleanName(v) { if (!NAME_RE.test(String(v || ''))) fail(422, 'secret.invalid', 'a name is 1-64 characters: a lowercase letter, then lowercase letters, digits, _ or -'); return String(v); }
function cleanValue(v) {
    if (typeof v !== 'string' || !v.length) fail(422, 'secret.invalid', 'value must be a non-empty string');
    if (Buffer.byteLength(v, 'utf8') > MAX_VALUE_BYTES) fail(422, 'secret.too_large', `a value is at most ${MAX_VALUE_BYTES} bytes`);
    if (/\u0000/.test(v)) fail(422, 'secret.invalid', 'value must not contain NUL');
    return v;
}
const subjectOf = (label) => String(label || '').replace(/^user:/, '');

function grantView(g) {
    return { service: g.service, purposes: JSON.parse(g.purposes), origins: JSON.parse(g.origins || '[]'), created_at: g.created_at, created_by: subjectOf(g.created_by), last_used_at: g.last_used_at || null };
}
function secretView(row, grants) {
    return {
        project_id: row.project_id, environment: row.environment, name: row.name, version: Number(row.version), fingerprint: row.fingerprint,
        grants: grants.map(grantView), created_at: row.created_at, created_by: subjectOf(row.created_by), updated_at: row.updated_at, updated_by: subjectOf(row.updated_by),
    };
}

async function grantsOf(db, row) {
    return await db.prepare('SELECT * FROM dev_project_secret_grants WHERE project_id = ? AND environment = ? AND name = ? ORDER BY service')
        .all(row.project_id, row.environment, row.name);
}
async function getRow(db, projectId, environment, name) {
    return await db.prepare('SELECT * FROM dev_project_secrets WHERE project_id = ? AND environment = ? AND name = ?').get(projectId, environment, name);
}
async function mustRow(db, projectId, environment, name) {
    const row = await getRow(db, projectId, environment, name);
    if (!row) fail(404, 'secret.not_found', 'no such secret');
    return row;
}

/** Members (viewer+) and staff: the project's secrets, metadata only; ?environment= narrows it. */
async function list(db, actor, projectId, { environment } = {}) {
    const { project } = await store.access(db, actor, projectId, { allowArchived: true });
    const env = environment ? cleanEnv(environment) : null;
    const rows = env
        ? await db.prepare('SELECT * FROM dev_project_secrets WHERE project_id = ? AND environment = ? ORDER BY environment, name').all(project.id, env)
        : await db.prepare('SELECT * FROM dev_project_secrets WHERE project_id = ? ORDER BY environment, name').all(project.id);
    const out = [];
    for (const r of rows) out.push(secretView(r, await grantsOf(db, r)));
    return out;
}

/** Admin+: set or replace a value (the version goes up by one). Answers the metadata, never the value. */
async function put(db, actor, projectId, environment, name, body, { ctx, config }) {
    const kr = requireKeys(config);
    const { project } = await store.access(db, actor, projectId, { need: 'admin', staffOk: false });
    const env = cleanEnv(environment);
    const n = cleanName(name);
    const value = cleanValue(body && body.value);
    let row;
    await db.tx(async () => {
        await store.lockProject(db, project.id);
        const existing = await getRow(db, project.id, env, n);
        if (!existing) {
            const { c } = await db.prepare('SELECT COUNT(*) AS c FROM dev_project_secrets WHERE project_id = ? AND environment = ?').get(project.id, env);
            if (Number(c) >= MAX_PER_ENV) fail(409, 'secret.limit', `a project environment holds at most ${MAX_PER_ENV} secrets`);
        }
        const at = nowIso();
        const version = existing ? Number(existing.version) + 1 : 1;
        const ident = { project_id: project.id, environment: env, name: n, version };
        const sealed = seal(kr, ident, value);
        const fingerprint = fingerprintOf(kr, value);
        if (existing) {
            await db.prepare('UPDATE dev_project_secrets SET version = ?, key_id = ?, iv = ?, tag = ?, ciphertext = ?, fingerprint = ?, updated_at = ?, updated_by = ? WHERE project_id = ? AND environment = ? AND name = ?')
                .run(version, kr.id, sealed.iv, sealed.tag, sealed.ciphertext, fingerprint, at, actor.label, project.id, env, n);
        } else {
            await db.prepare(`INSERT INTO dev_project_secrets (project_id, environment, name, version, key_id, iv, tag, ciphertext, fingerprint, created_at, created_by, updated_at, updated_by)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(project.id, env, n, version, kr.id, sealed.iv, sealed.tag, sealed.ciphertext, fingerprint, at, actor.label, at, actor.label);
        }
        await store.audit(db, { projectId: project.id, actor: actor.label, action: existing ? 'secret.replaced' : 'secret.created', target: `${env}/${n}`, detail: { environment: env, name: n, version, fingerprint }, ctx });
        row = await getRow(db, project.id, env, n);
    });
    return secretView(row, await grantsOf(db, row));
}

/** Admin+: delete a secret and its grants. */
async function remove(db, actor, projectId, environment, name, { ctx }) {
    const { project } = await store.access(db, actor, projectId, { need: 'admin', staffOk: false, allowArchived: true });
    const env = cleanEnv(environment);
    const n = cleanName(name);
    await db.tx(async () => {
        const row = await mustRow(db, project.id, env, n);
        await db.prepare('DELETE FROM dev_project_secret_grants WHERE project_id = ? AND environment = ? AND name = ?').run(project.id, env, n);
        await db.prepare('DELETE FROM dev_project_secrets WHERE project_id = ? AND environment = ? AND name = ?').run(project.id, env, n);
        await store.audit(db, { projectId: project.id, actor: actor.label, action: 'secret.deleted', target: `${env}/${n}`, detail: { environment: env, name: n, version: Number(row.version) }, ctx });
    });
}

/** Admin+: grant one service the secret for sign and/or reveal; reveal needs the https origins it may be sent to. */
async function putGrant(db, actor, projectId, environment, name, service, body, { ctx }) {
    const { project } = await store.access(db, actor, projectId, { need: 'admin', staffOk: false });
    const env = cleanEnv(environment);
    const n = cleanName(name);
    const svc = String(service || '');
    if (!SERVICE_RE.test(svc) || svc === 'network') fail(422, 'secret.invalid', 'service is an OpenVibe service id (svc:<id>), not network');
    const purposes = Array.isArray(body && body.purposes) ? [...new Set(body.purposes.map(String))].sort() : [];
    if (!purposes.length || purposes.some((p) => !PURPOSES.includes(p))) fail(422, 'secret.invalid', 'purposes is a non-empty list of sign and reveal');
    const origins = Array.isArray(body && body.origins) ? [...new Set(body.origins.map((o) => String(o).toLowerCase().replace(/\/+$/, '')))].sort() : [];
    if (origins.length > MAX_ORIGINS || origins.some((o) => !ORIGIN_RE.test(o))) fail(422, 'secret.invalid', `origins are at most ${MAX_ORIGINS} https origins (scheme, host and an optional port)`);
    if (purposes.includes('reveal') && !origins.length) fail(422, 'secret.invalid', 'reveal names the origins the value may be sent to');
    if (!purposes.includes('reveal') && origins.length) fail(422, 'secret.invalid', 'origins apply to reveal only');
    let out;
    await db.tx(async () => {
        const row = await mustRow(db, project.id, env, n);
        const existing = await db.prepare('SELECT * FROM dev_project_secret_grants WHERE project_id = ? AND environment = ? AND name = ? AND service = ?').get(project.id, env, n, svc);
        if (!existing) {
            const { c } = await db.prepare('SELECT COUNT(*) AS c FROM dev_project_secret_grants WHERE project_id = ? AND environment = ? AND name = ?').get(project.id, env, n);
            if (Number(c) >= MAX_GRANTS) fail(409, 'secret.limit', `a secret has at most ${MAX_GRANTS} grants`);
            await db.prepare('INSERT INTO dev_project_secret_grants (project_id, environment, name, service, purposes, origins, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run(project.id, env, n, svc, JSON.stringify(purposes), JSON.stringify(origins), nowIso(), actor.label);
        } else {
            await db.prepare('UPDATE dev_project_secret_grants SET purposes = ?, origins = ? WHERE project_id = ? AND environment = ? AND name = ? AND service = ?')
                .run(JSON.stringify(purposes), JSON.stringify(origins), project.id, env, n, svc);
        }
        await store.audit(db, { projectId: project.id, actor: actor.label, action: 'secret.granted', target: `${env}/${n}`, detail: { environment: env, name: n, service: svc, purposes, origins }, ctx });
        out = secretView(row, await grantsOf(db, row));
    });
    return out;
}

/** Admin+: take a service's grant away. */
async function removeGrant(db, actor, projectId, environment, name, service, { ctx }) {
    const { project } = await store.access(db, actor, projectId, { need: 'admin', staffOk: false, allowArchived: true });
    const env = cleanEnv(environment);
    const n = cleanName(name);
    await db.tx(async () => {
        await mustRow(db, project.id, env, n);
        const r = await db.prepare('DELETE FROM dev_project_secret_grants WHERE project_id = ? AND environment = ? AND name = ? AND service = ?').run(project.id, env, n, String(service || ''));
        if (!r.changes) fail(404, 'secret.grant_not_found', 'that service holds no grant on this secret');
        await store.audit(db, { projectId: project.id, actor: actor.label, action: 'secret.grant_revoked', target: `${env}/${n}`, detail: { environment: env, name: n, service: String(service) }, ctx });
    });
}

/**
 * A service uses a secret (network.secret.use): `principal` is the verified token's principal (sub svc:<id>), `body` a
 * network.secret-use-request@1. → network.secret-use-result@1. Every refusal past validation is 404 secret.not_found.
 */
async function use(db, principal, body, { ctx, config }) {
    const v = validate('network.secret-use-request@1', body);
    if (!v.valid) fail(400, 'request.invalid', v.errors.map((e) => `${e.path} ${e.message}`).join('; ').slice(0, 300));
    const kr = requireKeys(config);
    const service = String((principal && principal.sub) || '').replace(/^svc:/, '');
    if (!SERVICE_RE.test(service)) notFound();
    const project = await db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(body.project_id);
    if (!project || project.archived_at) notFound();
    const row = await getRow(db, project.id, body.environment, body.name);
    if (!row || !row.ciphertext) notFound();
    const grant = await db.prepare('SELECT * FROM dev_project_secret_grants WHERE project_id = ? AND environment = ? AND name = ? AND service = ?').get(project.id, body.environment, body.name, service);
    if (!grant || !JSON.parse(grant.purposes).includes(body.purpose)) notFound();
    if (body.purpose === 'reveal' && !JSON.parse(grant.origins || '[]').includes(String(body.origin).toLowerCase())) notFound();
    let value;
    try { value = open(kr, row); } catch { value = null; }
    if (value == null) fail(503, 'secrets.unavailable', 'this secret cannot be opened with the configured key');
    const at = nowIso();
    const day = at.slice(0, 10);
    await db.prepare('UPDATE dev_project_secret_grants SET last_used_at = ?, last_audit_day = ? WHERE project_id = ? AND environment = ? AND name = ? AND service = ?')
        .run(at, day, project.id, body.environment, body.name, service);
    if (grant.last_audit_day !== day) {
        await store.audit(db, { projectId: project.id, actor: `service:${service}`, action: 'secret.used', target: `${body.environment}/${body.name}`,
            detail: { environment: body.environment, name: body.name, service, purpose: body.purpose, version: Number(row.version), ...(body.origin ? { origin: body.origin } : {}) }, ctx });
    }
    const result = { name: row.name, version: Number(row.version), purpose: body.purpose };
    if (body.purpose === 'sign') result.signature = crypto.createHmac('sha256', value).update(body.message, 'utf8').digest('hex');
    else result.value = value;
    return result;
}

/** Archiving a project (or deleting its owner's account) shreds its secrets: the ciphertexts go, the metadata stays. → count */
async function shredProject(db, projectId) {
    const r = await db.prepare('UPDATE dev_project_secrets SET ciphertext = NULL, iv = NULL, tag = NULL WHERE project_id = ? AND ciphertext IS NOT NULL').run(projectId);
    return r.changes || 0;
}

module.exports = { list, put, remove, putGrant, removeGrant, use, shredProject, keyring, fingerprintOf, MAX_VALUE_BYTES, MAX_PER_ENV };
