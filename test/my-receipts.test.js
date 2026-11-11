'use strict';
// The Receipts card on openvibe.my (plan OpenVibe_Seven_Domains_Plan R2 item 13): GET /api/v1/me/receipts hands the
// person's own token to Mail, and my/receipts.js draws the latest five under Needs you, a counted fold for the rest,
// and one quiet line that links to the Inbox AI switch when it is off (or there is no mailbox). No sample receipts.
//   node test/my-receipts.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const vm = require('vm');
const { router, receiptOf } = require('../server/today/receipts');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'my.html'), 'utf8');
const JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'my', 'receipts.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'my.css'), 'utf8');

// ── The page: the person leads, then Needs you, actions, history, sites, machines, numbers and receipts ──
assert.ok(HTML.indexOf('id="page-header"') < HTML.indexOf('id="needs-you"'));
assert.ok(HTML.indexOf('id="needs-you"') < HTML.indexOf('id="me-acts"'));
assert.ok(HTML.indexOf('id="td-continue"') < HTML.indexOf('id="td-sites"'));
assert.ok(HTML.indexOf('id="td-sites"') < HTML.indexOf('id="td-machines-summary"'));
assert.ok(HTML.indexOf('id="td-machines-summary"') < HTML.indexOf('id="td-nums"'));
assert.ok(HTML.indexOf('id="td-nums"') < HTML.indexOf('id="receipts"'));
assert.match(HTML, /<section class="rc" id="receipts" hidden/);
assert.match(HTML, /<script src="\/js\/my\/receipts\.js" defer><\/script>/, 'the card has its own script');
assert.match(CSS, /\.rc-row \{/, 'the rows have a style');

class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.className = ''; this.hidden = false; this.listeners = {}; this._text = ''; this.style = {}; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    append(...kids) { for (const k of kids) this.children.push(typeof k === 'string' ? Object.assign(new Node('#text'), { _text: k }) : k); }
    replaceChildren(...kids) { this.children = []; this.append(...kids); }
    remove() {}
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    click() { (this.listeners.click || []).forEach((fn) => fn({})); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get href() { return this.attrs.href; }
    querySelector(sel) { return sel === 'summary' ? this.summary : sel === '.setup-items' ? this.items : null; }
    all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
}

function page() {
    const ids = {};
    for (const [, id] of HTML.matchAll(/id="([^"]+)"/g)) ids[id] = new Node('div');
    ids['setup-fold'].hidden = true;
    ids['setup-fold'].summary = new Node('summary');
    ids['setup-fold'].items = new Node('div');
    const sandbox = {
        document: { getElementById: (id) => ids[id] || null, createElement: (t) => new Node(t) },
        console, Date, Number, String, Array, Map, Set, Math, JSON, Promise, encodeURIComponent,
        isAnonSession: () => false,
    };
    vm.runInNewContext(JS, sandbox);
    return { ids, sandbox };
}

const receipt = (i) => ({
    thread_id: `thr_${i}`, message_id: `msg_${i}`, merchant: `Shop ${i}`,
    subject: `Order ${i}`, summary: `Order ${i} delivered`, received_at: '2026-11-08T09:30:00Z',
});

(async () => {
    // ── Inbox AI off: one counted setup fold, no empty Receipts card, and no sample receipt ──
    let p = page();
    p.sandbox.renderReceipts({ enabled: false, receipts: [] });
    assert.strictEqual(p.ids.receipts.hidden, true, 'no empty Receipts card');
    assert.strictEqual(p.ids['setup-fold'].hidden, false);
    assert.strictEqual(p.ids['setup-fold'].summary.textContent, 'Set up more (1)');
    assert.strictEqual(p.ids['setup-fold'].items.children[0].textContent, 'Set up receipts with Inbox AI');
    assert.strictEqual(p.ids['setup-fold'].items.children[0].getAttribute('href'), 'https://openvibe.email/inbox#inbox-ai');

    // ── On with receipts: the latest five, then a counted fold for the rest, each a thread on openvibe.email ──
    p = page();
    p.sandbox.renderReceipts({ enabled: true, receipts: [0, 1, 2, 3, 4, 5, 6].map(receipt) });
    assert.strictEqual(p.ids.receipts.hidden, false);
    const body = p.ids['receipts-body'];
    assert.strictEqual(body.children.filter((c) => c.className === 'rc-row').length, 5, 'five rows are shown');
    const rest = body.children.find((c) => c.className === 'rc-rest');
    const more = body.children.find((c) => c.className === 'rc-more');
    assert.ok(rest && more, 'the rest are a fold, not a tab');
    assert.strictEqual(rest.hidden, true);
    assert.strictEqual(rest.children.length, 2);
    assert.strictEqual(more.textContent, 'More (2)', 'the fold is counted');
    assert.strictEqual(more.getAttribute('aria-expanded'), 'false');
    const rows = body.all((c) => c.className === 'rc-row');
    assert.strictEqual(rows[0].href, 'https://openvibe.email/inbox/msg_0', 'each row links its thread');
    assert.match(rows[0].textContent, /^Shop 0Order 0 delivered.+$/, 'merchant, one-line summary, date');
    assert.strictEqual(rows[0].getAttribute('target'), '_blank');
    more.click();
    assert.strictEqual(rest.hidden, false, 'More unfolds');
    assert.strictEqual(more.textContent, 'Show less');
    assert.strictEqual(more.getAttribute('aria-expanded'), 'true');
    assert.strictEqual(body.all((c) => c.className === 'rc-row').length, 7);
    more.click();
    assert.strictEqual(rest.hidden, true, 'and folds again');
    assert.strictEqual(more.textContent, 'More (2)');

    // A thread with no message id falls back to its thread id; nothing else is turned into a link.
    assert.strictEqual(receiptOf({ thread_id: 'thread 1', summary: 'x' }), null, 'a bad id is not passed');
    p = page();
    p.sandbox.renderReceipts({ enabled: true, receipts: [{ ...receipt(0), message_id: null, thread_id: 'thr_ok' }] });
    assert.strictEqual(p.ids['receipts-body'].all((c) => c.tagName === 'A')[0].href, 'https://openvibe.email/inbox/thr_ok');

    // ── On with nothing triaged yet: neither receipts nor setup nudge is shown ──
    p = page();
    p.sandbox.renderReceipts({ enabled: true, receipts: [] });
    assert.strictEqual(p.ids.receipts.hidden, true);
    assert.strictEqual(p.ids['setup-fold'].hidden, true);

    // ── The route: Mail is asked with the person's own token; off hides rows, on passes them, down stays out ──
    const seen = [];
    let mode = 'off';
    const mail = http.createServer((req, res) => {
        seen.push({ url: req.url, auth: req.headers.authorization });
        if (mode === 'down') { res.statusCode = 503; return res.end('{}'); }
        res.setHeader('content-type', 'application/json');
        if (mode === 'off') return res.end(JSON.stringify({ enabled: false, receipts: [receipt(0)] }));
        return res.end(JSON.stringify({ enabled: true, receipts: [receipt(0), receipt(1), { thread_id: 'bad id', summary: 'x' }] }));
    });
    await new Promise((r) => mail.listen(0, '127.0.0.1', r));
    const app = express();
    const requireAuth = (req, _res, next) => { req.user = { id: 7, is_anon: false }; req.token = 'person-token'; next(); };
    app.use('/api/v1/me/receipts', router({ requireAuth, mailUrl: `http://127.0.0.1:${mail.address().port}/` }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1/me/receipts`;
    const get = async () => { const r = await fetch(base); return { r, d: await r.json() }; };
    try {
        let { r, d } = await get();
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(d, { enabled: false, receipts: [] }, 'off: no rows, even if an old Mail kept some');
        assert.strictEqual(seen[0].url, '/api/v1/me/mail/receipts');
        assert.strictEqual(seen[0].auth, 'Bearer person-token', "Mail gets the person's own token");

        mode = 'on';
        ({ r, d } = await get());
        assert.strictEqual(d.enabled, true);
        assert.strictEqual(d.receipts.length, 2, 'a bad id is dropped');
        assert.deepStrictEqual(Object.keys(d.receipts[0]), ['thread_id', 'message_id', 'merchant', 'subject', 'summary', 'received_at']);
        assert.match(r.headers.get('cache-control'), /private, no-store/);

        mode = 'down';
        ({ r, d } = await get());
        assert.strictEqual(r.status, 502);
        assert.strictEqual(d.error, 'mail.unavailable');
    } finally {
        server.close();
        mail.close();
        console.log('my-receipts: off line, five rows and counted fold, thread links, and the route ok');
    }
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
