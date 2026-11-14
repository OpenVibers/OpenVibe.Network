'use strict';
/**
 * Setup done by your agent (plan §AB.44; the owner, 11-14: "configure all the API keys … using the on-screen system …
 * have the user log in or make accounts … and then gather it from that using the agent").
 *
 * A one-time setup grant lets the owner's own agent save the key(s) of exactly one Setup row, once:
 *
 *   POST   /api/admin/setup/grants        owner, fresh sign-in  { service, namespace, keys[1..4], provider?, get_it_at? }
 *                                                                → 201 { grant: { id, ref, service, namespace, keys,
 *                                                                        expires_at } }   the id is shown once
 *   GET    /api/admin/setup/grants        owner                 → the owner's live grants (ref, row, expiry; never ids)
 *   DELETE /api/admin/setup/grants/:ref   owner                 → revoked
 *   POST   /internal/setup/grants/:id/save   network.setup.grant.save (OpenVibe.Actor only)
 *                                                                { values: { key: value }, run? } → 200
 *                                                                network.setup-grant-saved@1 { saved, service,
 *                                                                namespace, keys: [{ key, hint }] }
 *
 * What a grant can do is narrow on purpose: one service, one namespace, the key(s) the owner chose, for 30 minutes,
 * once. The id is a bearer handle only together with Actor's service token; only its SHA-256 is stored. The first
 * save spends it (an atomic update before anything is written), so a replay finds nothing. It can never read a value:
 * the save goes through the owner settings proxy's own secret path (sealed by the owning service, audited as saved
 * by the owner's agent) and the answer names each key with its last four characters. A value is never logged.
 */
const crypto = require('crypto');
const express = require('express');

const TTL_MS = 30 * 60 * 1000;
const KEY_RE = /^[a-z][a-z0-9_.-]{0,79}$/;
const SERVICE_RE = /^[a-z][a-z0-9-]{0,39}$/;
const NAMESPACE_RE = /^[a-z][a-z0-9_.-]{0,79}$/;
const ID_RE = /^sgr_[A-Za-z0-9_-]{32}$/;
const REF_RE = /^[a-f0-9]{12}$/;
const hashOf = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
const hintOf = (v) => `…${String(v).slice(-4)}`;
const iso = (t) => new Date(t).toISOString();

class GrantError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/**
 * proxy.saveSecretAsOwner(req, { service, namespace, key, value }): the owner settings proxy's secret write, done for
 * the grant's owner (server/admin/ai-config-proxy.js). isFresh(req): the owner's fresh sign-in (the same rule saving a
 * key by hand has).
 */
function createSetupGrants({ db, proxy, isFresh, now = () => Date.now(), log = console } = {}) {
    async function create(req, body) {
        if (!isFresh(req, now())) throw new GrantError(403, 'config.fresh_required', "Confirm it's you to let your agent save a key");
        const b = body && typeof body === 'object' ? body : {};
        const service = String(b.service || '');
        const namespace = String(b.namespace || '');
        const keys = Array.isArray(b.keys) ? [...new Set(b.keys.map(String))] : [];
        if (!SERVICE_RE.test(service) || !NAMESPACE_RE.test(namespace) || !namespace.startsWith(`${service}.`)) throw new GrantError(400, 'setup_grant.bad_row', 'name one Setup row: its service and namespace');
        if (!keys.length || keys.length > 4 || !keys.every((k) => KEY_RE.test(k))) throw new GrantError(400, 'setup_grant.bad_keys', 'name one to four of the row\'s keys');
        const subject = String((req.user && req.user.subject_id) || '');
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject)) throw new GrantError(403, 'setup_grant.no_subject', 'the owner has no usr_ subject');
        const id = `sgr_${crypto.randomBytes(24).toString('base64url')}`;
        const hash = hashOf(id);
        const at = now();
        const provider = typeof b.provider === 'string' ? b.provider.slice(0, 60) : null;
        const getItAt = typeof b.get_it_at === 'string' && /^https:\/\/[^\s]{1,500}$/.test(b.get_it_at) ? b.get_it_at : null;
        await db.prepare(`INSERT INTO setup_grants (id_hash, owner_user_id, owner_subject, service, namespace, keys, provider, get_it_at, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hash, req.user.id, subject, service, namespace, JSON.stringify(keys), provider, getItAt, iso(at), iso(at + TTL_MS));
        return { id, ref: hash.slice(0, 12), service, namespace, keys, provider, get_it_at: getItAt, expires_at: iso(at + TTL_MS) };
    }

    async function list(req) {
        const rows = await db.prepare(`SELECT id_hash, service, namespace, keys, provider, created_at, expires_at FROM setup_grants
            WHERE owner_user_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 20`).all(req.user.id, iso(now()));
        return rows.map((r) => ({ ref: r.id_hash.slice(0, 12), service: r.service, namespace: r.namespace, keys: JSON.parse(r.keys), provider: r.provider,
            created_at: new Date(r.created_at).toISOString(), expires_at: new Date(r.expires_at).toISOString() }));
    }

    async function revoke(req, ref) {
        if (!REF_RE.test(ref)) throw new GrantError(404, 'setup_grant.not_found', 'no such grant');
        const r = await db.prepare(`UPDATE setup_grants SET revoked_at = ? WHERE owner_user_id = ? AND substr(id_hash, 1, 12) = ?
            AND used_at IS NULL AND revoked_at IS NULL`).run(iso(now()), req.user.id, ref);
        if (!Number(r.changes)) throw new GrantError(404, 'setup_grant.not_found', 'no such grant');
    }

    /** The agent's one save. The grant is spent first (atomically), so a replay or a race finds nothing. */
    async function save(req, id, body) {
        if (!ID_RE.test(id)) throw new GrantError(404, 'setup_grant.not_found', 'no such grant');
        const b = body && typeof body === 'object' ? body : {};
        const values = b.values && typeof b.values === 'object' && !Array.isArray(b.values) ? b.values : null;
        const keys = values ? Object.keys(values) : [];
        if (!keys.length || keys.length > 4 || !keys.every((k) => KEY_RE.test(k) && typeof values[k] === 'string' && values[k].length >= 1 && values[k].length <= 8192)) {
            throw new GrantError(400, 'setup_grant.bad_values', 'one to four of the grant\'s keys, each a value');
        }
        const run = typeof b.run === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(b.run) ? b.run : null;
        const hash = hashOf(id);
        const grant = await db.prepare('SELECT * FROM setup_grants WHERE id_hash = ?').get(hash);
        if (!grant || grant.revoked_at || grant.used_at || Date.parse(new Date(grant.expires_at).toISOString()) <= now()) {
            throw new GrantError(410, 'setup_grant.gone', 'this grant is spent, revoked or expired');
        }
        const allowed = new Set(JSON.parse(grant.keys));
        const stray = keys.filter((k) => !allowed.has(k));
        if (stray.length) throw new GrantError(403, 'setup_grant.other_key', 'a grant saves only its own key(s)');
        const spent = await db.prepare(`UPDATE setup_grants SET used_at = ?, used_by = ?, run = ?, saved_keys = ?
            WHERE id_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
            .run(iso(now()), String(req.principal && req.principal.sub || ''), run, JSON.stringify(keys), hash, iso(now()));
        if (!Number(spent.changes)) throw new GrantError(410, 'setup_grant.gone', 'this grant is spent, revoked or expired');
        // The owner's own save, as the owner (the proxy's secret path), one key at a time.
        const ownerReq = { app: req.app, headers: {}, user: { id: grant.owner_user_id, subject_id: grant.owner_subject }, savedBy: 'agent', run };
        const out = [];
        for (const key of keys) {
            await proxy.saveSecretAsOwner(ownerReq, { service: grant.service, namespace: grant.namespace, key, value: values[key] });
            out.push({ key, hint: hintOf(values[key]) });
        }
        log.info && log.info(`[setup-grants] ${grant.service}/${grant.namespace}: ${keys.length} key(s) saved by the owner's agent${run ? ` (run ${run})` : ''}`);
        return { saved: true, service: grant.service, namespace: grant.namespace, keys: out };
    }

    const send = (res, err) => {
        if (err instanceof GrantError) return res.status(err.status).json({ ok: false, code: err.code, error: err.message });
        const status = Number(err && err.status) || 502;
        log.warn && log.warn(`[setup-grants] ${String(err && err.code || '')} ${String(err && err.message || err).slice(0, 120)}`);
        return res.status(status >= 400 && status < 600 ? status : 502).json({ ok: false, code: (err && err.code) || 'setup_grant.failed', error: 'the save did not go through' });
    };

    function ownerRouter() {
        const r = express.Router();
        r.use(express.json({ limit: '8kb' }));
        r.post('/', async (req, res) => { try { res.status(201).json({ ok: true, grant: await create(req, req.body) }); } catch (err) { send(res, err); } });
        r.get('/', async (req, res) => { try { res.set('Cache-Control', 'no-store').json({ ok: true, grants: await list(req) }); } catch (err) { send(res, err); } });
        r.delete('/:ref', async (req, res) => { try { await revoke(req, String(req.params.ref)); res.json({ ok: true }); } catch (err) { send(res, err); } });
        return r;
    }
    function internalHandler() {
        return [express.json({ limit: '40kb' }), async (req, res) => {
            res.set('Cache-Control', 'no-store');
            // Only OpenVibe.Actor's service client runs the setup skill.
            if (!req.principal || req.principal.sub !== 'svc:actor') return res.status(403).json({ ok: false, code: 'setup_grant.not_actor', error: 'only OpenVibe.Actor saves through a grant' });
            try { res.json(await save(req, String(req.params.id), req.body)); } catch (err) { send(res, err); }
        }];
    }
    return { create, list, revoke, save, ownerRouter, internalHandler, TTL_MS };
}

module.exports = { createSetupGrants, GrantError, TTL_MS, hashOf };
