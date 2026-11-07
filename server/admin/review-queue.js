'use strict';
/**
 * The publication reviewer queue (plan 2026-10-22 §"Publications", lines 947-952): one page for
 * everything OpenVibe.Wiki, Blog, News and Trade hold for a person's review, oldest first.
 *
 * Why here: OpenVibe.Publishing is code, never a runtime (its README: no port, domain, database or
 * API of its own), so the queue is hosted by the service that already gives staff one console for
 * every product — Network's admin — and uses the products' own gate reasons and review routes.
 *
 *   GET  /admin/review        the queue, grouped by site, noindex, staff only
 *   POST /admin/review/action approve (indexable) or keep hidden, through the owning service's own
 *                             review route. The product checks the person's role again and writes
 *                             its own append-only review log; Network never invents a decision.
 *
 * Each service exposes GET /api/v1/review-queue to a staff/editor user token (its own check), and
 * the existing review routes do the work. The token forwarded is the signed-in person's, renewed by
 * Network's requireAuth, so a role granted a moment ago counts upstream.
 */
const crypto = require('crypto');
const express = require('express');
const contracts = require('openvibe-contracts');
const kit = require('openvibe-shared/kit');
const shell = require('openvibe-shared/shell');

const SITES = [
    { id: 'wiki', name: 'OpenVibe.Wiki', env: 'OV_WIKI_INTERNAL_URL', fallback: 'http://127.0.0.1:4800' },
    { id: 'blog', name: 'OpenVibe.Blog', env: 'OV_BLOG_INTERNAL_URL', fallback: 'http://127.0.0.1:4810' },
    { id: 'news', name: 'OpenVibe.News', env: 'OV_NEWS_INTERNAL_URL', fallback: 'http://127.0.0.1:4820' },
    { id: 'trade', name: 'OpenVibe.Trade', env: 'OV_TRADE_INTERNAL_URL', fallback: 'http://127.0.0.1:4860' },
];
const SITE_BY_ID = new Map(SITES.map((s) => [s.id, s]));
const KIND_LABEL = Object.freeze({
    wiki_page: 'Wiki page', blog_draft: 'Blog draft', blog_post: 'Blog post',
    ai_brief: 'AI brief', news_story: 'News story', company_page: 'Company page',
});
const KINDS = new Set(Object.keys(KIND_LABEL));
const DECISIONS = new Set(['approved', 'rejected']);
const FIRST = 6;                  // per site before the rest fold behind "More (N)"
const MAX_ITEMS = 2000;           // a service that answers too much cannot exhaust the page

const esc = kit.esc;
const ageText = (iso, now) => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const mins = Math.max(0, Math.floor((now - ms) / 60000));
    if (mins < 60) return `${mins || 1} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours} h`;
    const days = Math.floor(hours / 24);
    if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? '' : 's'}`;
};

/** A URL kept only when it is an https URL or a same-site path. */
const safeUrl = (u) => {
    const s = String(u == null ? '' : u).trim();
    if (/^https:\/\//i.test(s)) return s;
    if (/^\/[^/]/.test(s)) return s;
    return '#';
};

function serviceBase(site, env = process.env) {
    return String(env[site.env] || site.fallback).replace(/\/+$/, '');
}

/** One item from a service, defensively shaped: a bad row is skipped, never rendered as trusted. */
function itemOf(raw, site, now) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.site !== site.id || !KINDS.has(raw.kind)) return null;
    if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 200) return null;
    if (typeof raw.title !== 'string' || !raw.title) return null;
    const createdAt = new Date(raw.createdAt);
    if (!Number.isFinite(createdAt.getTime())) return null;
    const revision = raw.revision == null ? null : Number(raw.revision);
    if (revision != null && !Number.isInteger(revision)) return null;
    const reasons = Array.isArray(raw.reasons) ? raw.reasons.filter((r) => r && typeof r.text === 'string').slice(0, 6).map((r) => ({ code: String(r.code || ''), text: r.text.slice(0, 300) })) : [];
    // Which kind of review an item already had (a service adds this): the AI editor's decision, or a
    // person's. Anything else is ignored — an item is still shown, just without the fact.
    const kind = raw.reviewed && typeof raw.reviewed === 'object' ? raw.reviewed.kind : null;
    const decision = raw.reviewed && typeof raw.reviewed === 'object' ? raw.reviewed.decision : null;
    const reviewed = (kind === 'ai_editor' || kind === 'person') && (decision === 'approved' || decision === 'rejected') ? {
        kind, decision,
        by: typeof raw.reviewed.by === 'string' ? raw.reviewed.by.slice(0, 120) : null,
        label: typeof raw.reviewed.label === 'string' ? raw.reviewed.label.slice(0, 300) : null,
    } : null;
    return {
        site: site.id, kind: raw.kind, id: raw.id, title: raw.title.slice(0, 300),
        revision, state: typeof raw.state === 'string' ? raw.state : null, ref: typeof raw.ref === 'string' ? raw.ref : null,
        url: safeUrl(raw.url), editUrl: raw.editUrl == null ? null : safeUrl(raw.editUrl),
        createdAt: createdAt.toISOString(), age: ageText(createdAt.toISOString(), now),
        reasons: reasons.length ? reasons : [{ code: 'noindex_requested', text: 'Waiting for a person\'s review.' }],
        reviewed,
    };
}

/** Fetch every site's queue in parallel; a down service becomes a visible section error, not a blank page. */
async function collect({ token, fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = 5000, env = process.env } = {}) {
    const errors = [];
    const items = [];
    await Promise.all(SITES.map(async (site) => {
        const base = serviceBase(site, env);
        try {
            const res = await fetchImpl(`${base}/api/v1/review-queue`, {
                headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
                redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) { errors.push({ site: site.id, name: site.name, status: res.status }); return; }
            const data = await res.json();
            const rows = data && Array.isArray(data.items) ? data.items.slice(0, MAX_ITEMS) : [];
            for (const row of rows) { const item = itemOf(row, site, now); if (item) items.push(item); }
        } catch {
            errors.push({ site: site.id, name: site.name, status: 0 });
        }
    }));
    items.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.site < b.site ? -1 : a.site > b.site ? 1 : 0));
    return { items, errors, counts: Object.fromEntries(SITES.map((s) => [s.id, items.filter((i) => i.site === s.id).length])) };
}

function kindOf(kind) { return KIND_LABEL[kind] || kind; }

function actionForms(item, csrf) {
    const base = { csrf, site: item.site, kind: item.kind, id: item.id, revision: item.revision == null ? '' : String(item.revision), ref: item.ref || '', state: item.state || '' };
    const approve = kit.action({ action: '/admin/review/action', hidden: { ...base, decision: 'approved' }, label: 'Approve (indexable)', icon: 'check', kind: 'primary', small: true });
    const keep = kit.action({ action: '/admin/review/action', hidden: { ...base, decision: 'rejected' }, label: 'Keep hidden', icon: 'ban', kind: 'quiet', small: true });
    return `<span class="rq-actions">${approve}${keep}</span>`;
}

function itemRow(item, csrf) {
    const href = item.editUrl || item.url;
    const title = `<a href="${esc(safeUrl(href))}">${esc(item.title)}</a>`;
    const why = item.reasons.map((r) => r.text).join(' · ');
    // Which kind of review the item already had: a person's, or the AI editor's (with its date).
    const who = item.reviewed ? (item.reviewed.kind === 'ai_editor' ? 'the AI editor' : 'a person') : null;
    const reviewedText = item.reviewed
        ? (item.reviewed.label || `${item.reviewed.decision === 'approved' ? 'Checked' : 'Kept hidden'} by ${who}`)
        : '';
    const meta = [
        item.age ? `${item.age} waiting` : '',
        who ? `last review by ${who}` : '',
    ].filter(Boolean).join(' · ');
    return kit.row({
        titleHtml: title,
        badge: kit.badge(kindOf(item.kind)),
        meta,
        metaIso: item.createdAt,
        sub: [why, reviewedText].filter(Boolean).join(' · '),
        trail: actionForms(item, csrf),
    });
}

function siteSection(site, items, csrf) {
    const list = items.length ? kit.list(items.slice(0, FIRST).map((i) => itemRow(i, csrf))) : kit.empty({ title: 'Nothing is waiting', text: `${site.name} has no page waiting for a person's review.` });
    const rest = items.slice(FIRST);
    const more = rest.length ? kit.fold({
        id: `rq-${site.id}-more`,
        title: `More (${rest.length})`,
        meta: `${items.length} in all`,
        body: kit.list(rest.map((i) => itemRow(i, csrf))),
    }) : '';
    return kit.section({ id: `rq-${site.id}`, title: site.name, count: items.length, note: items.length ? 'Oldest first' : '', body: list + more });
}

function renderPage({ items, errors, counts, csrf, config, now = Date.now(), saved = null }) {
    const total = items.length;
    // Stacked sections, oldest waiting first; a site with nothing waiting sits at the end.
    const failed = new Set(errors.map((e) => e.site));
    const grouped = SITES.filter((site) => !failed.has(site.id)).map((site) => ({ site, items: items.filter((i) => i.site === site.id) }))
        .sort((a, b) => (a.items[0] ? Date.parse(a.items[0].createdAt) : Infinity) - (b.items[0] ? Date.parse(b.items[0].createdAt) : Infinity));
    const stats = kit.stats([
        [total, 'waiting for review'],
        ...SITES.map((s) => [counts[s.id], s.name.replace('OpenVibe.', '')]),
    ], { label: 'Review queue numbers' });
    const notices = [
        saved && saved.error ? kit.notice({ kind: 'error', text: saved.error }) : '',
        saved && saved.ok ? kit.notice({ kind: 'ok', text: saved.ok }) : '',
        ...errors.map((e) => kit.notice({ kind: 'warn', text: `${e.name} did not answer${e.status ? ` (${e.status})` : ''}; its section is missing.` })),
    ].join('');
    const empty = !total && !errors.length
        ? kit.empty({ title: 'Nothing is waiting', text: 'Every publication has a person\'s decision for its AI-written text.', icon: 'check' })
        : '';
    const body = `<main class="rq">
${kit.head({ title: 'Review queue', sub: 'Everything waiting for a person, oldest first.', back: { href: '/admin', label: 'Admin' } })}
${notices}
${stats}
${empty || grouped.map(({ site, items: rows }) => siteSection(site, rows, csrf)).join('\n')}
</main>`;
    return shell.page({
        name: 'network', service: 'network',
        title: 'Review queue', siteName: 'OpenVibe.Network',
        description: 'Every Wiki page, Blog draft, AI brief and company page waiting for a person\'s review.',
        canonical: `${String(config.baseUrl || 'https://openvibe.network').replace(/\/+$/, '')}/admin/review`,
        robots: 'noindex, nofollow',
        head: `<link rel="stylesheet" href="/shared/kit.css">
<script src="/shared/kit-web.js" defer></script>
<style>
.rq{max-width:900px;margin:0 auto;padding:16px}
.rq .ovk-head{margin-bottom:12px}
.rq-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.rq-actions form{margin:0}
.rq .ovk-row-trail{max-width:100%}
@media (max-width:599px){
.rq .ovk-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:12px 0;padding:0;overflow:visible;gap:8px}
.rq .ovk-row--static{flex-direction:column;align-items:stretch;gap:6px}
.rq .ovk-row-main{width:100%}
.rq .ovk-row-trail{width:100%}
.rq .ovk-row-top{flex-wrap:wrap}
.rq .ovk-row-top strong{flex:1 1 100%;white-space:normal;overflow:visible;text-overflow:clip}
.rq .ovk-row-top strong a{display:block;overflow-wrap:anywhere}
.rq .ovk-row-sub>span:first-child{white-space:normal;overflow:visible}
.rq-actions{justify-content:flex-start}
}
</style>`,
        body,
        navLinks: [{ label: 'Admin', href: '/admin' }],
        navbar: { service: 'network' },
        footer: { service: 'network', variant: 'compact' },
    });
}

/** HMAC over the person, purpose and expiry; the key is Network's signing key (never a new secret). */
function csrfToken(user, key, now = Date.now()) {
    const exp = Math.floor(now / 1000) + 3600;
    const body = `${user.id}.${exp}`;
    return `${body}.${crypto.createHmac('sha256', key).update(`review-queue:${body}`).digest('base64url')}`;
}
function csrfOk(token, user, key, now = Date.now()) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || String(parts[0]) !== String(user.id)) return false;
    const exp = Number(parts[1]);
    if (!Number.isInteger(exp) || exp < Math.floor(now / 1000)) return false;
    const want = crypto.createHmac('sha256', key).update(`review-queue:${parts[0]}.${parts[1]}`).digest('base64url');
    const a = Buffer.from(String(parts[2])), b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createReviewQueueRouter({ requireAuth, config = {}, privateKey, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 5000, env = process.env }) {
    const router = express.Router();
    const form = express.urlencoded({ extended: false, limit: '8kb' });
    const editorial = (req) => Boolean(req.user && req.tokenClaims && contracts.staff.can(req.tokenClaims, 'staff.editorial.manage'));
    const refuse = (req, res) => {
        res.status(403).type('html').set('Cache-Control', 'no-store').send(shell.page({
            name: 'network', service: 'network', title: 'Staff only', robots: 'noindex, nofollow',
            canonical: `${String(config.baseUrl || 'https://openvibe.network').replace(/\/+$/, '')}/admin/review`,
            head: '<link rel="stylesheet" href="/shared/kit.css">',
            body: `<main class="rq"><h1>Staff only</h1><p>Only OpenVibe editorial staff review the publications.</p><p><a href="/">OpenVibe.Network</a></p></main>`,
            navLinks: [{ label: 'Admin', href: '/admin' }],
        }));
    };
    const guard = [requireAuth, (req, res, next) => (editorial(req) ? next() : refuse(req, res))];

    router.get('/', guard, async (req, res, next) => {
        try {
            const key = (req.app.locals && req.app.locals.privateKey) || privateKey;
            if (!key) throw new Error('the signing key is not loaded');
            const got = await collect({ token: req.token, fetchImpl, now: now(), timeoutMs, env });
            const saved = req.query.saved ? { ok: String(req.query.saved).slice(0, 300) } : null;
            const failed = req.query.error ? { error: String(req.query.error).slice(0, 300) } : null;
            res.set('Cache-Control', 'no-store').type('html').send(renderPage({
                ...got, csrf: csrfToken(req.user, key, now()), config, now: now(), saved: saved || failed,
            }));
        } catch (err) {
            next(err);
        }
    });

    router.post('/action', ...guard, form, async (req, res, next) => {
        try {
            const key = (req.app.locals && req.app.locals.privateKey) || privateKey;
            if (!key || !csrfOk(req.body && req.body.csrf, req.user, key, now())) {
                return res.redirect(303, '/admin/review?error=' + encodeURIComponent('That form expired. Reload the queue and try again.'));
            }
            const b = req.body || {};
            const site = SITE_BY_ID.get(String(b.site || ''));
            const kind = String(b.kind || '');
            const id = String(b.id || '');
            const decision = String(b.decision || '');
            const revision = Number(b.revision);
            const ref = String(b.ref || '');
            if (!site || !KINDS.has(kind) || !id || !DECISIONS.has(decision) || (b.revision !== '' && !Number.isInteger(revision))) {
                return res.redirect(303, '/admin/review?error=' + encodeURIComponent('That item could not be read. Reload the queue and try again.'));
            }
            const base = serviceBase(site, env);
            const body = { decision, note: '' };
            let path;
            if (site.id === 'wiki' && kind === 'wiki_page' && Number.isInteger(revision)) path = `/api/v1/pages/${encodeURIComponent(id)}/revisions/${revision}/review`;
            else if (site.id === 'blog' && (kind === 'blog_draft' || kind === 'blog_post') && Number.isInteger(revision)) path = `/api/v1/posts/${encodeURIComponent(id)}/reviews`;
            else if (site.id === 'news' && kind === 'news_story' && Number.isInteger(revision)) path = `/api/v1/stories/${encodeURIComponent(id)}/reviews`;
            else if (site.id === 'news' && kind === 'ai_brief') path = `/api/v1/briefs/${encodeURIComponent(id)}/reviews`;
            else if (site.id === 'trade' && kind === 'company_page' && Number.isInteger(revision) && ref) path = `/api/v1/instruments/${encodeURIComponent(ref)}/context/revisions/${revision}/review`;
            else return res.redirect(303, '/admin/review?error=' + encodeURIComponent('That item has no action for its kind.'));

            if (site.id === 'news' && kind === 'ai_brief') { body.kind = 'summary'; body.tone = 'neutral'; }
            if (site.id !== 'news' || kind !== 'ai_brief') body.revision = revision;
            const call = async (p, payload) => {
                const r = await fetchImpl(`${base}${p}`, {
                    method: 'POST', redirect: 'error',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${req.token}` },
                    body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
                });
                if (!r.ok) {
                    const problem = await r.json().catch(() => null);
                    throw new Error((problem && (problem.detail || problem.title)) || `the service answered ${r.status}`);
                }
                return await r.json().catch(() => ({}));
            };
            await call(path, body);
            // A draft is reviewed and then published: the review alone leaves it a draft (still noindex).
            if (decision === 'approved' && site.id === 'blog' && kind === 'blog_draft') await call(`/api/v1/posts/${encodeURIComponent(id)}/publish`, { revision });
            if (decision === 'approved' && site.id === 'news' && kind === 'news_story' && b.state !== 'published') await call(`/api/v1/stories/${encodeURIComponent(id)}/publish`, { revision });
            const what = decision === 'approved' ? 'Approved' : 'Kept hidden';
            res.redirect(303, '/admin/review?saved=' + encodeURIComponent(`${what}: ${site.name}.`));
        } catch (err) {
            next(err);
        }
    });

    // A failed upstream write shows on the page, not as a stack trace.
    router.use((err, req, res, next) => {
        if (!err || res.headersSent) return next(err);
        res.redirect(303, '/admin/review?error=' + encodeURIComponent(String(err.message || 'The action did not complete').slice(0, 300)));
    });

    return router;
}

module.exports = { SITES, KIND_LABEL, collect, itemOf, renderPage, createReviewQueueRouter, csrfToken, csrfOk, ageText };
