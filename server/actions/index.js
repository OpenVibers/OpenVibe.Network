'use strict';
/**
 * The Action Center (plan 2026-10-28 §3.10, capability network.actions.read): one list of a person's agent work, read
 * by the ✦ beside the bell on every OpenVibe site with the person's Network token.
 *
 *   GET  /api/v1/me/actions                          network.me-actions-result@1
 *   POST /api/v1/me/actions/:service/:id/:action     approve | decline | cancel → { item } (common.action-item@1), or a problem
 *
 * Sources, asked in parallel for the person's subject:
 *   network  their pending confirmations (server/developer/confirmations.js): waiting, approve or decline here;
 *   actor    GET <actor>/api/v1/actions?subject=   (actor.actions.read)   agent tasks, approvals, scheduled agents;
 *   codes    GET <codes>/api/v1/actions?subject=   (codes.actions.read)   coding tasks;
 *   ai       GET <ai>/api/v1/actions?subject=      (ai.actions.read)      AI runs on their behalf;
 *   domains  GET <domains>/api/v1/actions?subject= (domains.actions.read) DNS change proposals, approved or declined here.
 * Network signs its own short tokens for each (server/identity/self-token.js). Each source has ACTIONS_TIMEOUT_MS; a
 * slow, failing or not-yet-deployed one is left out and named in `sources` (partial: true), never failing the answer.
 * Every item is validated against common.action-item@1; one that is not valid is dropped, never shown half-formed.
 * The merged answer is kept CACHE_MS per person, and dropped when they act.
 */
const express = require('express');
const { validate, http } = require('openvibe-contracts');
const confirmations = require('../developer/confirmations');
const store = require('../developer/store');

const BUCKETS = ['running', 'waiting', 'scheduled', 'done', 'failed'];
const REMOTE = ['actor', 'codes', 'ai', 'domains'];
// Who can approve or decline from the Action Center, and how: the capability Network signs for, and the route.
const DECIDE = {
    actor: { cap: 'actor.approval.decide', path: (id) => `/api/v1/approvals/${encodeURIComponent(id)}/decide`, name: 'OpenVibe.Actor', what: 'approval' },
    domains: { cap: 'domains.proposal.decide', path: (id) => `/api/v1/proposals/${encodeURIComponent(id)}/decide`, name: 'OpenVibe.Domains', what: 'proposal' },
};
// Who can cancel from the Action Center, and how: the capability Network signs for, and the route. The Dock's
// Cancel button was dead before this: the item offered it (common.action-item@1) and the rail refused it.
const CANCEL = {
    actor: { cap: 'actor.task.create', path: (id) => '/api/v1/tasks/' + encodeURIComponent(id) + '/cancel', name: 'OpenVibe.Actor', what: 'task' },
};
const ACTIONS_TIMEOUT_MS = 2500;
const CACHE_MS = 10_000;
const CACHE_MAX = 500;
const PER_BUCKET = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** A pending Network confirmation as an Action Center item (waiting). */
function confirmationItem(c, agent) {
    const by = agent && (agent.name || agent.id);
    return {
        service: 'network', id: c.id, kind: 'approval',
        title: clip(c.summary || c.capability, 160) || 'An approval',
        summary: clip(by ? `${by} asks to use ${c.capability}` : `Asked to use ${c.capability}`, 400),
        bucket: 'waiting', state: c.state, agent: by ? clip(by, 80) : null, cost_usd: null, steps: null, error: null,
        created_at: new Date(c.created_at).toISOString(), updated_at: new Date(c.created_at).toISOString(), next_run_at: null,
        href: 'https://openvibe.network/my#approvals', actions: ['approve', 'decline', 'open'],
    };
}

function createActions({ db, selfToken = () => null, urls = {}, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), timeoutMs = ACTIONS_TIMEOUT_MS, log = console, confirmationsImpl = confirmations } = {}) {
    const cache = new Map();
    let warned = 0;

    async function remote(service, subject) {
        const base = urls[service];
        const token = base ? selfToken(`openvibe.${service}`, [`${service}.actions.read`]) : null;
        if (!base || !token) return { status: 'not_connected', items: [] };
        try {
            const res = await fetchImpl(`${String(base).replace(/\/+$/, '')}/api/v1/actions?subject=${encodeURIComponent(subject)}`, {
                headers: { accept: 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs),
            });
            // A service that has not deployed the route yet answers 404: not connected, not an outage.
            if (res.status === 404) return { status: 'not_connected', items: [] };
            if (!res.ok) return { status: 'unavailable', items: [] };
            const body = await res.json().catch(() => null);
            const items = body && Array.isArray(body.items) ? body.items : [];
            return { status: 'ok', items: items.filter((it) => it && it.service === service) };
        } catch (err) {
            return { status: err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'unavailable', items: [] };
        }
    }

    async function local(actor) {
        try {
            const out = await confirmationsImpl.list(db, actor, { state: 'pending', limit: 50 });
            return { status: 'ok', items: out.confirmations.map((c) => confirmationItem(c, out.agents[c.requested_by.id])) };
        } catch (err) {
            log.warn('[Actions] confirmations:', err.message);
            return { status: 'unavailable', items: [] };
        }
    }

    /** network.me-actions-result@1 for one person (an actorOf() actor). */
    async function forPerson(actor) {
        const hit = cache.get(actor.subject);
        if (hit && now() - hit.at < CACHE_MS) return hit.doc;
        const results = await Promise.all([local(actor), ...REMOTE.map((s) => remote(s, actor.subject))]);
        const sources = {};
        const buckets = Object.fromEntries(BUCKETS.map((b) => [b, []]));
        ['network', ...REMOTE].forEach((svc, i) => {
            sources[svc] = results[i].status;
            for (const it of results[i].items) {
                if (!validate('common.action-item@1', it).valid) {
                    if (warned++ < 20) log.warn(`[Actions] ${svc} answered an item that is not common.action-item@1; dropped`);
                    continue;
                }
                buckets[it.bucket].push(it);
            }
        });
        for (const b of BUCKETS) {
            buckets[b].sort((x, y) => (b === 'scheduled' ? String(x.next_run_at || '').localeCompare(String(y.next_run_at || '')) : String(y.updated_at).localeCompare(String(x.updated_at))));
            buckets[b] = buckets[b].slice(0, PER_BUCKET);
        }
        const doc = {
            buckets, counts: Object.fromEntries(BUCKETS.map((b) => [b, buckets[b].length])), sources,
            partial: Object.values(sources).some((s) => s === 'timeout' || s === 'unavailable'), generated_at: new Date(now()).toISOString(),
        };
        cache.set(actor.subject, { at: now(), doc });
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return doc;
    }

    /** Approve, decline or cancel one item through its authority. → common.action-item@1 */
    async function act(actor, service, id, action, ctx) {
        if (!ID_RE.test(String(id))) throw Object.assign(new Error('no such item'), { status: 404, code: 'actions.not_found' });
        if (action !== 'approve' && action !== 'decline' && action !== 'cancel') throw Object.assign(new Error('this item cannot do that here: open it instead'), { status: 422, code: 'actions.unsupported' });
        if (action === 'cancel') return await cancel(actor, service, id, ctx);
        cache.delete(actor.subject);
        if (service === 'network') {
            const out = await confirmationsImpl.decide(db, actor, id, action === 'approve' ? 'approve' : 'deny', {}, { ctx });
            return { ...confirmationItem(out.confirmation, null), bucket: 'done', actions: ['open'], updated_at: new Date(now()).toISOString() };
        }
        const d = DECIDE[service];
        if (!d) throw Object.assign(new Error('this item cannot do that here: open it instead'), { status: 422, code: 'actions.unsupported' });
        const token = urls[service] ? selfToken(`openvibe.${service}`, [d.cap]) : null;
        if (!token) throw Object.assign(new Error(`${d.name} is not connected`), { status: 503, code: 'actions.not_connected' });
        const res = await fetchImpl(`${String(urls[service]).replace(/\/+$/, '')}${d.path(id)}`, {
            method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-ov-subject': actor.subject },
            body: JSON.stringify({ decision: action }), signal: AbortSignal.timeout(timeoutMs * 2),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 404) throw Object.assign(new Error(`no such ${d.what}`), { status: 404, code: 'actions.not_found' });
        if (res.status === 409) throw Object.assign(new Error((body && body.detail) || `this ${d.what} was decided already`), { status: 409, code: 'actions.decided' });
        if (!res.ok) throw Object.assign(new Error((body && (body.detail || body.title)) || `${d.name} answered ${res.status}`), { status: 502, code: 'actions.upstream' });
        return body;
    }

    /**
     * Cancel one running item through its authority. The item leaves the running bucket and the person gets the
     * item as it is now, so the Dock can redraw it without a second read.
     */
    async function cancel(actor, service, id, ctx) {
        const c = CANCEL[service];
        if (!c) throw Object.assign(new Error('this item cannot do that here: open it instead'), { status: 422, code: 'actions.unsupported' });
        const token = urls[service] ? selfToken('openvibe.' + service, [c.cap]) : null;
        if (!token) throw Object.assign(new Error(c.name + ' is not connected'), { status: 503, code: 'actions.not_connected' });
        const res = await fetchImpl(String(urls[service]).replace(/\/+$/, '') + c.path(id), {
            method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-ov-subject': actor.subject },
            body: JSON.stringify({}), signal: AbortSignal.timeout(timeoutMs * 2),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 404) throw Object.assign(new Error('no such ' + c.what), { status: 404, code: 'actions.not_found' });
        if (!res.ok && res.status !== 202) throw Object.assign(new Error((body && (body.detail || body.title)) || (c.name + ' answered ' + res.status)), { status: 502, code: 'actions.upstream' });
        const doc = await forPerson(actor);
        const item = Object.values(doc.buckets || {}).flat().find((it) => it.service === service && it.id === id);
        return item || {
            service, id, kind: 'agent_task', title: '', summary: null, bucket: 'failed', state: 'cancelled',
            agent: null, cost_usd: null, steps: null, error: null,
            created_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString(),
            next_run_at: null, href: null, actions: ['open'],
        };
    }

    return { forPerson, act, _cache: cache };
}

/** The routes, behind Network's session check (cookie on openvibe.network, Bearer elsewhere), like the bell's. */
function router({ actions, requireAuth, requireDock = () => requireAuth }) {
    const r = express.Router();
    r.use(express.json({ limit: '4kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    r.get('/', requireDock('activity'), async (req, res) => {
        try {
            const actor = await store.actorOf(req.app.locals.db, req.user);
            res.json(await actions.forPerson(actor));
        } catch (err) {
            if (err && err.status) return http.sendProblem(res, err.status, err.code || 'actions.error', { detail: err.message });
            console.error('[Actions] list:', err);
            http.sendProblem(res, 500, 'actions.error', { detail: 'could not read your actions' });
        }
    });
    r.post('/:service/:id/:action', requireAuth, async (req, res) => {
        try {
            const actor = await store.actorOf(req.app.locals.db, req.user);
            res.json({ item: await actions.act(actor, String(req.params.service), String(req.params.id), String(req.params.action), req.ov) });
        } catch (err) {
            if (err && err.status) return http.sendProblem(res, err.status, err.code || 'actions.error', { detail: err.message });
            console.error('[Actions] act:', err);
            http.sendProblem(res, 500, 'actions.error', { detail: 'could not do that' });
        }
    });
    return r;
}

module.exports = { createActions, router, confirmationItem, BUCKETS, ACTIONS_TIMEOUT_MS, CACHE_MS, CANCEL };
