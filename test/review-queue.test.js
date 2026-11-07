'use strict';
/**
 * The publication reviewer queue (server/admin/review-queue.js): one staff page across Wiki, Blog,
 * News and Trade, oldest first, grouped by site with a "More (N)" fold; approve/keep-hidden call the
 * owning service's own review route (and publish a draft after approval), with the person's token.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const contracts = require('openvibe-contracts');
const { createReviewQueueRouter, collect, csrfToken, csrfOk } = require('../server/admin/review-queue');

const ADMIN_CAPS = contracts.staff.capabilitiesOf({ role: 'admin' });

function upstream(label, items) {
    const seen = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body: body ? JSON.parse(body) : null });
            if (req.url === '/api/v1/review-queue') {
                res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: items.map((i) => ({ ...i, site: label })) }));
            } else {
                res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
            }
        });
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` })));
}

const item = (id, kind, createdAt, extra = {}) => ({
    id, kind, title: `Title ${id}`, revision: 2, url: `/x/${id}`, createdAt,
    reasons: [{ code: 'ai_generated_unreviewed', text: 'AI-written and not reviewed by a person.' }],
    review: { method: 'POST', path: '/ignored' }, ...extra,
});

(async () => {
    const wiki = await upstream('wiki', [item('pg_a', 'wiki_page', '2026-10-01T00:00:00Z'), item('pg_b', 'wiki_page', '2026-10-03T00:00:00Z', {
        // A page the AI editor kept hidden: the queue names which kind of review it had.
        reviewed: { kind: 'ai_editor', decision: 'rejected', by: 'svc:orchestrator', at: '2026-10-02T00:00:00Z', label: "Kept hidden by OpenVibe's AI editor on 2026-10-02" },
    })]);
    const blog = await upstream('blog', [item('pst_a', 'blog_draft', '2026-10-02T00:00:00Z'), item('pst_b', 'blog_draft', '2026-10-04T00:00:00Z', { reviewed: { kind: 'robot', decision: 'approved', label: 'not a kind' } }), item('pst_c', 'blog_draft', '2026-10-05T00:00:00Z'), item('pst_d', 'blog_draft', '2026-10-06T00:00:00Z'), item('pst_e', 'blog_draft', '2026-10-07T00:00:00Z'), item('pst_f', 'blog_draft', '2026-10-08T00:00:00Z'), item('pst_g', 'blog_draft', '2026-10-09T00:00:00Z')]);
    const news = await upstream('news', [item('clu_a', 'ai_brief', '2026-09-30T00:00:00Z')]);
    const trade = await upstream('trade', [item('ins_a', 'company_page', '2026-09-29T00:00:00Z', { ref: 'ACME' })]);
    const env = { OV_WIKI_INTERNAL_URL: wiki.url, OV_BLOG_INTERNAL_URL: blog.url, OV_NEWS_INTERNAL_URL: news.url, OV_TRADE_INTERNAL_URL: trade.url };
    const key = 'test-signing-key';

    const requireAuth = (req, res, next) => {
        const raw = req.headers['x-test-user'];
        if (!raw) return res.status(401).json({ error: 'Authentication required' });
        const u = JSON.parse(raw);
        req.user = { id: u.id, role: u.role, subject_id: `usr_${String(u.id).padStart(26, '0')}` };
        req.token = `token-${u.id}`;
        req.tokenClaims = { staff_caps: u.caps || [] };
        next();
    };
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/admin/review', createReviewQueueRouter({ requireAuth, config: { baseUrl: 'https://openvibe.network' }, privateKey: key, env }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = (extra = {}) => ({ 'x-test-user': JSON.stringify({ id: 7, role: 'admin', caps: ADMIN_CAPS, ...extra }) });
    const page = async (headers = auth()) => {
        const r = await fetch(`${base}/admin/review`, { headers, redirect: 'manual' });
        return { status: r.status, text: await r.text() };
    };
    const post = async (form, headers = auth()) => {
        const r = await fetch(`${base}/admin/review/action`, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), redirect: 'manual' });
        return { status: r.status, location: r.headers.get('location') || '', text: await r.text() };
    };
    const csrfOf = (text) => (text.match(/name="csrf" value="([^"]+)"/) || [])[1];

    try {
        let r = await page();
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.ok(r.text.includes('OpenVibe.Wiki') && r.text.includes('OpenVibe.Blog') && r.text.includes('OpenVibe.News') && r.text.includes('OpenVibe.Trade'));
        assert.ok(r.text.includes('More (1)'), 'the 7th Blog row is folded behind More (1)');
        assert.ok(r.text.includes('last review by the AI editor'), 'the queue shows which kind of review the item had');
        assert.match(r.text, /Kept hidden by OpenVibe(?:&#39;|')s AI editor on 2026-10-02/, 'and what it said');
        assert.ok(!r.text.includes('not a kind'), 'an unknown review kind is ignored, never rendered');
        assert.ok(r.text.includes('Title clu_a') && r.text.includes('AI brief'));
        assert.ok(r.text.indexOf('More (1)') < r.text.indexOf('Title pst_g'), 'the 7th row is inside the fold');
        assert.strictEqual(r.text.split('Title pst_g').length, 2, 'the folded row appears once');
        assert.ok(r.text.indexOf('Title ins_a') < r.text.indexOf('Title clu_a'), 'oldest first across sites');
        assert.ok(wiki.seen.some((x) => x.auth === 'Bearer token-7'), 'the person\'s token is forwarded');

        r = await page(auth({ caps: [] }));
        assert.strictEqual(r.status, 403, 'a non-editorial staff token gets 403');
        assert.ok(r.text.includes('Staff only'));

        const csrf = csrfOf((await page()).text);
        assert.ok(csrf && csrfOk(csrf, { id: 7 }, key), 'the form token verifies');
        assert.ok(!csrfOk(csrf, { id: 8 }, key), 'and binds the person');

        r = await post({ csrf, site: 'wiki', kind: 'wiki_page', id: 'pg_a', revision: '2', decision: 'approved' });
        assert.strictEqual(r.status, 303);
        assert.match(r.location, /saved=Approved/);
        let sent = wiki.seen.filter((x) => x.method === 'POST');
        assert.deepStrictEqual(sent.map((x) => x.url), ['/api/v1/pages/pg_a/revisions/2/review']);
        assert.deepStrictEqual(sent[0].body, { decision: 'approved', note: '', revision: 2 });

        wiki.seen.length = 0; blog.seen.length = 0;
        r = await post({ csrf, site: 'blog', kind: 'blog_draft', id: 'pst_a', revision: '2', decision: 'approved' });
        assert.strictEqual(r.status, 303);
        sent = blog.seen.filter((x) => x.method === 'POST');
        assert.deepStrictEqual(sent.map((x) => x.url), ['/api/v1/posts/pst_a/reviews', '/api/v1/posts/pst_a/publish'], 'review, then publish the draft');

        r = await post({ csrf, site: 'news', kind: 'ai_brief', id: 'clu_a', revision: '', decision: 'approved' });
        assert.strictEqual(r.status, 303);
        sent = news.seen.filter((x) => x.method === 'POST');
        assert.deepStrictEqual(sent.map((x) => x.url), ['/api/v1/briefs/clu_a/reviews']);
        assert.deepStrictEqual(sent[0].body, { decision: 'approved', note: '', kind: 'summary', tone: 'neutral' });

        r = await post({ csrf, site: 'trade', kind: 'company_page', id: 'ins_a', revision: '2', ref: 'ACME', decision: 'rejected' });
        assert.strictEqual(r.status, 303);
        sent = trade.seen.filter((x) => x.method === 'POST');
        assert.deepStrictEqual(sent.map((x) => x.url), ['/api/v1/instruments/ACME/context/revisions/2/review']);
        assert.deepStrictEqual(sent[0].body, { decision: 'rejected', note: '', revision: 2 });

        r = await post({ csrf: 'bad', site: 'wiki', kind: 'wiki_page', id: 'pg_a', revision: '2', decision: 'approved' });
        assert.strictEqual(r.status, 303);
        assert.match(r.location, /error=/);

        // A service that does not answer is a visible section, not a blank page.
        await new Promise((resolve) => wiki.srv.close(resolve));
        r = await page();
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('OpenVibe.Wiki did not answer'), 'a down service is named in the page');

        const got = await collect({ token: 't', fetchImpl: async () => ({ ok: false, status: 502 }), timeoutMs: 100, env });
        assert.deepStrictEqual(got.items, []);
        assert.strictEqual(got.errors.length, 4);
        assert.strictEqual(csrfToken({ id: 7 }, key).split('.').length, 3);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        for (const u of [wiki, blog, news, trade]) { try { await new Promise((resolve) => u.srv.close(resolve)); } catch { /* already closed */ } }
    }
    console.log('review-queue.test.js: ok');
})().catch((e) => { console.error(e); process.exit(1); });
