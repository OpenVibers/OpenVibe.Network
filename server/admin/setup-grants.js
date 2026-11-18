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
 *   DELETE /api/admin/setup/grants/:ref[?task=tsk_…]  owner     → { state: revoked | saving | spent | save_failed,
 *                                                                  task_stopped, task_state: stopped | stopping |
 *                                                                  not_stopped }: the agent's task is stopped too
 *                                                                  (11-14 review); spent only once the key is written,
 *                                                                  task_stopped only once Actor says it ended (11-15)
 *   GET    /api/admin/setup/grants/agent/:task         owner  → the agent's work for the Setup row's overlay: { state,
 *                                                                ended, error, needs_you: { what }, desk, page }
 *   GET    /api/admin/setup/grants/agent/:task/still   owner  → its desk's latest picture (image, no-store)
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
const TASK_RE = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const STILL_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const STILL_MAX = 4 * 1024 * 1024;
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
// The providers whose new keys OpenVibe.Actor can read from their page (Actor's server/setup/grants.js KEY_SHAPES).
const AGENT_PROVIDERS = ['openai', 'anthropic', 'deepseek', 'openrouter', 'groq', 'gemini', 'kimi', 'xai', 'fireworks', 'resend', 'stripe'];

function createSetupGrants({ db, proxy, isFresh, now = () => Date.now(), log = console, actorUrl = '', actorPublicUrl = 'https://openvibe.actor', fetchImpl = globalThis.fetch, stopPollMs = 1000 } = {}) {
    /**
     * Start the owner's agent on the grant (Actor's POST /api/v1/tasks with { setup }, with the owner's own Bearer): the grant id
     * goes from here to Actor and nowhere else, so the browser never holds it. A start that fails revokes the grant.
     */
    async function startAgent(req, id, grant) {
        const auth = String(req.headers && req.headers.authorization || '');
        if (!/^Bearer\s+\S+/.test(auth) || !actorUrl) throw new GrantError(409, 'setup_grant.agent_unavailable', 'Your agent could not start here: sign in again, or paste the key yourself');
        let res;
        try {
            res = await fetchImpl(`${actorUrl.replace(/\/+$/, '')}/api/v1/tasks`, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
                headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: auth },
                body: JSON.stringify({ setup: { grant: id, keys: grant.keys, provider: grant.provider, label: grant.label || grant.provider, get_it_at: grant.get_it_at } }),
            });
        } catch { res = null; }
        const out = res ? await res.json().catch(() => null) : null;
        if (!res || !res.ok || !out || !out.id) {
            await db.prepare('UPDATE setup_grants SET revoked_at = ? WHERE id_hash = ? AND used_at IS NULL').run(iso(now()), hashOf(id));
            throw new GrantError(502, 'setup_grant.agent_failed', (out && (out.detail || out.title)) ? String(out.detail || out.title).slice(0, 200) : 'Your agent did not start');
        }
        return { id: String(out.id), url: `${actorPublicUrl.replace(/\/+$/, '')}/chat/${encodeURIComponent(String(out.id))}` };
    }

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
        const made = { id, ref: hash.slice(0, 12), service, namespace, keys, provider, get_it_at: getItAt, expires_at: iso(at + TTL_MS) };
        // "Let my agent do it": the agent starts here, and the answer carries its task, never the grant id.
        if (b.start === true) {
            const p = String(provider || '').toLowerCase();
            if (!AGENT_PROVIDERS.includes(p) || !getItAt) {
                await db.prepare('UPDATE setup_grants SET revoked_at = ? WHERE id_hash = ?').run(iso(now()), hash);
                throw new GrantError(422, 'setup_grant.agent_cannot', 'Your agent cannot read this provider\'s keys from its page yet: paste it yourself');
            }
            const task = await startAgent(req, id, { keys, provider: p, label: typeof b.label === 'string' ? b.label.slice(0, 60) : p, get_it_at: getItAt });
            const { id: _hidden, ...rest } = made;
            return { ...rest, task };
        }
        return made;
    }

    async function list(req) {
        const rows = await db.prepare(`SELECT id_hash, service, namespace, keys, provider, created_at, expires_at FROM setup_grants
            WHERE owner_user_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 20`).all(req.user.id, iso(now()));
        return rows.map((r) => ({ ref: r.id_hash.slice(0, 12), service: r.service, namespace: r.namespace, keys: JSON.parse(r.keys), provider: r.provider,
            created_at: new Date(r.created_at).toISOString(), expires_at: new Date(r.expires_at).toISOString() }));
    }

    /**
     * Stop the agent's task (Actor's POST /api/v1/tasks/:id/cancel, the owner's own Bearer) → 'stopped' when Actor says
     * it ended (200, or 409: it had ended already), 'stopping' when Actor took the cancel but the task is still winding
     * down (202: it finishes the step it is on; read again three times, a second apart), 'not_stopped' otherwise. An
     * accepted cancel is never reported as a stopped task (the 11-15 review).
     */
    const ENDED = new Set(['succeeded', 'failed', 'cancelled']);
    const endedTask = (t) => Boolean(t && typeof t === 'object' && (t.finished_at || ENDED.has(String(t.state || ''))));
    async function stopAgent(req, task) {
        const auth = String(req.headers && req.headers.authorization || '');
        if (!TASK_RE.test(task) || !/^Bearer\s+\S+/.test(auth) || !actorUrl) return 'not_stopped';
        const base = `${actorUrl.replace(/\/+$/, '')}/api/v1/tasks/${encodeURIComponent(task)}`;
        const headers = { Accept: 'application/json', Authorization: auth };
        let res;
        try {
            res = await fetchImpl(`${base}/cancel`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
                headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
        } catch { return 'not_stopped'; }
        if (res.status === 409) return 'stopped';
        if (!res.ok) return 'not_stopped';
        if (endedTask(await res.json().catch(() => null))) return 'stopped';
        for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, stopPollMs));
            try {
                const again = await fetchImpl(base, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000), headers });
                if (again.ok && endedTask(await again.json().catch(() => null))) return 'stopped';
            } catch { /* read again */ }
        }
        return 'stopping';
    }

    /**
     * Take a grant back (the 11-14 review): honest about what happened. A grant whose key the agent saved says so (the
     * key stays in Setup, for the owner to remove there); a save still being written is "saving", one that failed
     * "save_failed" (11-15: used_at alone only means the agent claimed it); a live one is revoked; and with its task the
     * agent's task is stopped too, so nothing keeps working on the owner's behalf. → { state, task_stopped, task_state }
     */
    async function revoke(req, ref, task = null) {
        if (!REF_RE.test(ref)) throw new GrantError(404, 'setup_grant.not_found', 'no such grant');
        await db.prepare(`UPDATE setup_grants SET revoked_at = ? WHERE owner_user_id = ? AND substr(id_hash, 1, 12) = ?
            AND used_at IS NULL AND revoked_at IS NULL`).run(iso(now()), req.user.id, ref);
        const row = await db.prepare('SELECT used_at, revoked_at, saved_at, save_failed_at FROM setup_grants WHERE owner_user_id = ? AND substr(id_hash, 1, 12) = ?').get(req.user.id, ref);
        if (!row) throw new GrantError(404, 'setup_grant.not_found', 'no such grant');
        const state = !row.used_at ? 'revoked' : row.saved_at ? 'spent' : row.save_failed_at ? 'save_failed' : 'saving';
        const taskState = task ? await stopAgent(req, String(task)) : null;
        return { state, task_stopped: taskState === null ? null : taskState === 'stopped', task_state: taskState };
    }

    /**
     * The agent's one save. The grant is claimed first (used_at, atomically), so a replay or a race finds nothing; it is
     * spent (saved_at) only once every key is written, and a write that fails is recorded (save_failed_at, save_error)
     * so Stop and Setup never call it saved.
     */
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
        try {
            for (const key of keys) {
                await proxy.saveSecretAsOwner(ownerReq, { service: grant.service, namespace: grant.namespace, key, value: values[key] });
                out.push({ key, hint: hintOf(values[key]) });
            }
        } catch (err) {
            const code = String((err && (err.code || err.status)) || 'save_failed').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) || 'save_failed';
            await db.prepare('UPDATE setup_grants SET save_failed_at = ?, save_error = ? WHERE id_hash = ?').run(iso(now()), code, hash);
            log.warn && log.warn(`[setup-grants] ${grant.service}/${grant.namespace}: the agent's save failed after ${out.length} of ${keys.length} key(s) (${code})`);
            throw err;
        }
        await db.prepare('UPDATE setup_grants SET saved_at = ? WHERE id_hash = ?').run(iso(now()), hash);
        log.info && log.info(`[setup-grants] ${grant.service}/${grant.namespace}: ${keys.length} key(s) saved by the owner's agent${run ? ` (run ${run})` : ''}`);
        return { saved: true, service: grant.service, namespace: grant.namespace, keys: out };
    }

    /**
     * The agent's work as the Setup row's overlay shows it (plan §AB.44: its screen beside the step, not another tab):
     * read from Actor with the owner's own Bearer, so Actor decides the task is theirs. Only Actor's configured address
     * is ever fetched, on paths built here from a checked task id; a picture's address in Actor's answer is not followed.
     */
    function actorGet(req, path) {
        const auth = String(req.headers && req.headers.authorization || '');
        if (!/^Bearer\s+\S+/.test(auth) || !actorUrl) throw new GrantError(409, 'setup_grant.agent_unavailable', 'sign in again to watch your agent');
        return fetchImpl(`${actorUrl.replace(/\/+$/, '')}${path}`, {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', Authorization: auth },
        }).catch(() => null);
    }
    async function deskOf(req, task) {
        const res = await actorGet(req, `/api/v1/tasks/${task}/desks`);
        const body = res && res.ok ? await res.json().catch(() => null) : null;
        return body && Array.isArray(body.desks) && body.desks[0] ? body.desks[0] : null;
    }
    async function agentView(req, task) {
        if (!TASK_RE.test(task)) throw new GrantError(404, 'setup_grant.no_task', 'no such task');
        const [res, desk] = await Promise.all([actorGet(req, `/api/v1/tasks/${task}`), deskOf(req, task)]);
        if (!res) throw new GrantError(502, 'setup_grant.agent_silent', 'your agent did not answer');
        if (!res.ok) throw new GrantError(res.status === 404 || res.status === 403 ? 404 : 502, 'setup_grant.no_task', res.status === 404 || res.status === 403 ? 'no such task' : 'your agent did not answer');
        const t = await res.json().catch(() => ({}));
        return {
            state: String(t.state || ''),
            ended: Boolean(t.finished_at),
            error: t.error ? String(t.error.detail || t.error.code || '').slice(0, 200) : null,
            needs_you: t.needs_you && t.needs_you.what ? { what: String(t.needs_you.what).slice(0, 300) } : null,
            desk: desk ? { where: desk.where === 'run' ? 'run' : 'link', kind: desk.kind === 'browser' ? 'browser' : 'desktop', driving: Boolean(desk.driving) } : null,
            page: `${actorPublicUrl.replace(/\/+$/, '')}/chat/${task}`,
        };
    }
    async function agentStill(req, task) {
        if (!TASK_RE.test(task)) throw new GrantError(404, 'setup_grant.no_task', 'no such task');
        const desk = await deskOf(req, task);
        if (!desk) throw new GrantError(404, 'setup_grant.no_still', 'no screen yet');
        const name = /^[A-Za-z0-9_-]{1,40}$/.test(String(desk.desk || '')) ? desk.desk : 'private';
        const res = await actorGet(req, desk.where === 'run' ? `/api/v1/tasks/${task}/still` : `/api/v1/tasks/${task}/desk-still?desk=${encodeURIComponent(name)}`);
        const type = res ? String(res.headers.get('content-type') || '').split(';')[0].trim() : '';
        if (!res || !res.ok || !STILL_TYPES.has(type)) throw new GrantError(404, 'setup_grant.no_still', 'no screen yet');
        const bytes = Buffer.from(await res.arrayBuffer());
        if (!bytes.length || bytes.length > STILL_MAX) throw new GrantError(404, 'setup_grant.no_still', 'no screen yet');
        return { type, bytes };
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
        r.delete('/:ref', async (req, res) => {
            try { res.set('Cache-Control', 'no-store').json({ ok: true, ...(await revoke(req, String(req.params.ref), req.query.task ? String(req.query.task) : null)) }); } catch (err) { send(res, err); }
        });
        r.get('/agent/:task', async (req, res) => { try { res.set('Cache-Control', 'no-store').json({ ok: true, agent: await agentView(req, String(req.params.task)) }); } catch (err) { send(res, err); } });
        r.get('/agent/:task/still', async (req, res) => {
            try {
                const still = await agentStill(req, String(req.params.task));
                res.set('Cache-Control', 'private, no-store'); res.set('X-Content-Type-Options', 'nosniff');
                res.type(still.type).send(still.bytes);
            } catch (err) { send(res, err); }
        });
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
    return { create, list, revoke, save, agentView, agentStill, ownerRouter, internalHandler, TTL_MS };
}

module.exports = { createSetupGrants, GrantError, TTL_MS, hashOf, AGENT_PROVIDERS };
