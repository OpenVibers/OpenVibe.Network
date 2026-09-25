'use strict';
/**
 * Audited service grants (roadmap WS-D task 3; Contracts 0.48.0 network.principal_grant.changed; a
 * developer app's grant is network.grant.changed, from server/developer/store.js).
 *
 * principal_grants stays the one table tokens are issued from (principals.js grantsFor). DEFAULT_GRANTS
 * remain its seed; every change made here is owner-only, needs a reason, may carry an expiry, writes a
 * principal_grant_changes row and queues network.principal_grant.changed in the same transaction. A service's
 * next token (5 minutes at most) carries the change.
 *
 *   GET  /api/admin/grants[?client=]        every grant with its state (active, revoked, expired)
 *   GET  /api/admin/grants/changes[?client=] the audit trail, newest first
 *   POST /api/admin/grants                  { client_id, capability, audience?, namespaces?, expires_at?, reason }
 *   POST /api/admin/grants/revoke           { client_id, capability, audience?, reason }
 *
 * The audience defaults to, and must be, the capability owner's (openvibe.<owner>). Expired grants stop
 * counting at once (grantsFor filters them); expireDue(), every 10 minutes, records each expiry once.
 */
const express = require('express');
const { ids, validate, capabilities } = require('openvibe-contracts');
const eventRelay = require('../developer/event-relay');
const { isOwner } = require('../auth/owner-guard');

const EVENT_TYPE = 'network.principal_grant.changed';
const CLIENT_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CAP_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const GRANTABLE = new Set(['active', 'planned']);

class GrantError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function ensureSchema(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(principal_grants)').all().map((c) => c.name));
    if (!cols.has('expires_at')) db.exec('ALTER TABLE principal_grants ADD COLUMN expires_at DATETIME');
    if (!cols.has('reason')) db.exec('ALTER TABLE principal_grants ADD COLUMN reason TEXT');
    if (!cols.has('revoked_by')) db.exec('ALTER TABLE principal_grants ADD COLUMN revoked_by TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS principal_grant_changes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id   TEXT NOT NULL,
        capability  TEXT NOT NULL,
        audience    TEXT NOT NULL,
        change      TEXT NOT NULL CHECK (change IN ('granted', 'updated', 'revoked', 'expired')),
        namespaces  TEXT NOT NULL DEFAULT '[]',
        expires_at  TEXT,
        reason      TEXT,
        actor       TEXT,
        event_id    TEXT,
        at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_grant_changes_client ON principal_grant_changes(client_id, id);`);
}

const nowIso = () => new Date().toISOString();
const sqlNow = () => nowIso().replace('T', ' ').slice(0, 19);
const clean = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) || null);
function isoOrNull(v) {
    if (v == null || v === '') return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new GrantError(400, 'expires_at is not a date');
    return d.toISOString();
}
// principal_grants keeps SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC) so it compares with CURRENT_TIMESTAMP.
const toSql = (iso) => (iso ? iso.replace('T', ' ').slice(0, 19) : null);
const fromSql = (v) => (v ? new Date(`${String(v).replace(' ', 'T')}Z`).toISOString() : null);

function stateOf(r, now = sqlNow()) {
    if (r.revoked_at) return r.revoked_by === 'expiry' ? 'expired' : 'revoked';
    if (r.expires_at && r.expires_at <= now) return 'expired';
    return 'active';
}

function list(db, { client = null } = {}) {
    const rows = client
        ? db.prepare('SELECT * FROM principal_grants WHERE client_id = ? ORDER BY client_id, capability, audience').all(String(client))
        : db.prepare('SELECT * FROM principal_grants ORDER BY client_id, capability, audience').all();
    const now = sqlNow();
    return rows.map((r) => ({
        client_id: r.client_id, capability: r.capability, audience: r.audience, namespaces: JSON.parse(r.namespaces || '[]'),
        state: stateOf(r, now), granted_by: r.granted_by, granted_at: fromSql(r.granted_at), expires_at: fromSql(r.expires_at),
        revoked_at: fromSql(r.revoked_at), revoked_by: r.revoked_by || null, reason: r.reason || null,
    }));
}

function changes(db, { client = null, limit = 100 } = {}) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const rows = client
        ? db.prepare('SELECT * FROM principal_grant_changes WHERE client_id = ? ORDER BY id DESC LIMIT ?').all(String(client), n)
        : db.prepare('SELECT * FROM principal_grant_changes ORDER BY id DESC LIMIT ?').all(n);
    return rows.map((r) => ({ ...r, namespaces: JSON.parse(r.namespaces || '[]') }));
}

/** The audit row and the event, inside the caller's transaction. */
function record(db, { client_id, capability, audience, change, namespaces, expires_at, reason, actor }) {
    const ms = Date.now();
    const env = {
        event_id: ids.newId('event', ms), event_type: EVENT_TYPE, version: 1, source: 'network',
        actor: actor ? { type: 'user', id: actor } : { type: 'system', id: 'network' },
        timestamp: new Date(ms).toISOString(), visibility: 'internal', priority: 'important',
        subject: { type: 'grant', id: `${client_id}:${capability}@${audience}` },
        payload: { client_id, capability, audience, change, namespaces, expires_at: expires_at || null, reason: reason || null, actor_subject: actor || null },
    };
    const v = validate('events.event-envelope@1', env);
    const pv = validate(`${EVENT_TYPE}@1`, env.payload);
    if (!v.valid || !pv.valid) throw new Error(`grants: bad event: ${JSON.stringify((v.errors || []).concat(pv.errors || [])).slice(0, 300)}`);
    eventRelay.writerFor(db).enqueue(env);
    db.prepare(`INSERT INTO principal_grant_changes (client_id, capability, audience, change, namespaces, expires_at, reason, actor, event_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(client_id, capability, audience, change, JSON.stringify(namespaces), expires_at || null, reason || null, actor || null, env.event_id);
}

function kick(db) { const o = eventRelay.outboxFor(db); if (o) o.kick(); }

/** Check a request's grant target. → { client_id, capability, audience } */
function target(db, body) {
    const client_id = String(body.client_id || '');
    const capability = String(body.capability || '');
    if (!CLIENT_RE.test(client_id)) throw new GrantError(400, 'client_id is malformed');
    if (!db.prepare('SELECT 1 FROM oauth_clients WHERE client_id = ? AND is_first_party = 1').get(client_id)) throw new GrantError(404, `${client_id} is not a service principal`);
    if (!CAP_RE.test(capability)) throw new GrantError(400, 'capability is malformed');
    const cap = capabilities.get(capability);
    if (!cap) throw new GrantError(400, `${capability} is not in openvibe-contracts`);
    const audience = body.audience ? String(body.audience) : `openvibe.${cap.owner}`;
    if (audience !== `openvibe.${cap.owner}`) throw new GrantError(400, `${capability} is enforced by ${cap.owner}: the audience is openvibe.${cap.owner}`);
    return { client_id, capability, audience, status: cap.status };
}

function grant(db, body, actor) {
    const t = target(db, body);
    if (!GRANTABLE.has(t.status)) throw new GrantError(400, `${t.capability} is ${t.status}`);
    const reason = clean(body.reason, 500);
    if (!reason || reason.length < 3) throw new GrantError(400, 'a reason is required');
    const namespaces = Array.isArray(body.namespaces) ? [...new Set(body.namespaces.map((n) => String(n).trim()).filter(Boolean))].slice(0, 100) : [];
    if (namespaces.some((n) => !/^[a-z][a-z0-9_.*-]{0,199}$/.test(n))) throw new GrantError(400, 'a namespace is malformed');
    const expires_at = isoOrNull(body.expires_at);
    if (expires_at && expires_at <= nowIso()) throw new GrantError(400, 'expires_at is in the past');
    return db.transaction(() => {
        const prev = db.prepare('SELECT * FROM principal_grants WHERE client_id = ? AND capability = ? AND audience = ?').get(t.client_id, t.capability, t.audience);
        const wasActive = prev && stateOf(prev) === 'active';
        db.prepare(`INSERT INTO principal_grants (client_id, capability, audience, namespaces, granted_by, granted_at, expires_at, reason, revoked_at, revoked_by)
                    VALUES (@client_id, @capability, @audience, @namespaces, @actor, CURRENT_TIMESTAMP, @expires, @reason, NULL, NULL)
                    ON CONFLICT(client_id, capability, audience) DO UPDATE SET namespaces = excluded.namespaces, granted_by = excluded.granted_by,
                        granted_at = excluded.granted_at, expires_at = excluded.expires_at, reason = excluded.reason, revoked_at = NULL, revoked_by = NULL`)
            .run({ ...t, namespaces: JSON.stringify(namespaces), actor: actor || 'owner', expires: toSql(expires_at), reason });
        const change = wasActive ? 'updated' : 'granted';
        record(db, { ...t, change, namespaces, expires_at, reason, actor });
        return { ...t, change, namespaces, expires_at };
    })();
}

function revoke(db, body, actor) {
    const t = target(db, body);
    const reason = clean(body.reason, 500);
    if (!reason || reason.length < 3) throw new GrantError(400, 'a reason is required');
    return db.transaction(() => {
        const prev = db.prepare('SELECT * FROM principal_grants WHERE client_id = ? AND capability = ? AND audience = ?').get(t.client_id, t.capability, t.audience);
        if (!prev || stateOf(prev) !== 'active') throw new GrantError(404, 'no active grant to revoke');
        db.prepare("UPDATE principal_grants SET revoked_at = CURRENT_TIMESTAMP, revoked_by = ?, reason = ? WHERE client_id = ? AND capability = ? AND audience = ?")
            .run(actor || 'owner', reason, t.client_id, t.capability, t.audience);
        const namespaces = JSON.parse(prev.namespaces || '[]');
        record(db, { ...t, change: 'revoked', namespaces, expires_at: fromSql(prev.expires_at), reason, actor });
        return { ...t, change: 'revoked' };
    })();
}

/** Record every grant whose expiry has passed, once. → how many */
function expireDue(db) {
    const due = db.prepare('SELECT * FROM principal_grants WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP').all();
    for (const g of due) {
        db.transaction(() => {
            const n = db.prepare("UPDATE principal_grants SET revoked_at = expires_at, revoked_by = 'expiry' WHERE client_id = ? AND capability = ? AND audience = ? AND revoked_at IS NULL")
                .run(g.client_id, g.capability, g.audience).changes;
            if (n) record(db, { client_id: g.client_id, capability: g.capability, audience: g.audience, change: 'expired', namespaces: JSON.parse(g.namespaces || '[]'), expires_at: fromSql(g.expires_at), reason: g.reason || null, actor: null });
        })();
    }
    if (due.length) kick(db);
    return due.length;
}

function router(db) {
    const r = express.Router();
    r.use((req, res, next) => (req.user && isOwner(req.user) ? next() : res.status(403).json({ ok: false, error: 'Only the owner manages service grants' })));
    const send = (res, fn) => {
        try { res.json({ ok: true, ...fn() }); } catch (err) {
            if (err instanceof GrantError) return res.status(err.status).json({ ok: false, error: err.message });
            console.error('[Grants]', err.message);
            res.status(500).json({ ok: false, error: 'grant change failed' });
        }
    };
    const actorOf = (req) => (/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(req.user.subject_id || '')) ? req.user.subject_id : null);
    r.get('/', (req, res) => { res.set('Cache-Control', 'private, no-store'); send(res, () => ({ grants: list(db, { client: req.query.client }) })); });
    r.get('/changes', (req, res) => { res.set('Cache-Control', 'private, no-store'); send(res, () => ({ changes: changes(db, { client: req.query.client, limit: req.query.limit }) })); });
    r.post('/', (req, res) => send(res, () => { const out = grant(db, req.body || {}, actorOf(req)); kick(db); return { grant: out }; }));
    r.post('/revoke', (req, res) => send(res, () => { const out = revoke(db, req.body || {}, actorOf(req)); kick(db); return { grant: out }; }));
    return r;
}

let timer = null;
function start(db, { intervalMs = 10 * 60 * 1000 } = {}) {
    if (timer) return;
    const run = () => { try { expireDue(db); } catch (err) { console.warn('[Grants] expiry:', err.message); } };
    timer = setInterval(run, intervalMs);
    if (timer.unref) timer.unref();
    setImmediate(run);
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { ensureSchema, list, changes, grant, revoke, expireDue, router, start, stop, stateOf, GrantError };
