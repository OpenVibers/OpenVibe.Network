'use strict';
// openvibe-shared/boost.js on Network's pages (plan T11 step 3): /, /status and /updates carry the release marker
// (network@<served release id>), wrap what changes in <main id="main"> and load boost.js; the front door's static hero
// stays outside #main, a new release changes the / ETag, and the hero's intent picker still works.
//   node test/boost.test.js
const assert = require('assert');
const http = require('http');
const vm = require('vm');
const express = require('express');
const activity = require('../server/home/activity');
const home = require('../server/home/render');
const { createStatusRoutes } = require('../server/status/routes');
const { createUpdatesRoutes } = require('../server/updates/routes');

activity.setEnabled(false);
activity._set({ live: [], pastes: [], posts: [] });

const SCRIPT = '<script src="/shared/boost.js" data-main="#main" defer></script>';
const count = (s, needle) => s.split(needle).length - 1;
function boosted(html, page, releaseId) {
    assert.ok(html.includes(`<meta name="ov-boost" content="network@${releaseId}">`), `${page}: the release marker`);
    assert.strictEqual(count(html, 'name="ov-boost"'), 1, `${page}: one marker`);
    assert.ok(html.indexOf('name="ov-boost"') < html.indexOf('</head>'), `${page}: the marker is in <head>`);
    assert.strictEqual(count(html, 'id="main"'), 1, `${page}: one #main`);
    assert.strictEqual(count(html, SCRIPT), 1, `${page}: boost.js once`);
    assert.ok(html.indexOf(SCRIPT) > html.indexOf('</main>') && html.indexOf(SCRIPT) < html.indexOf('</body>'), `${page}: boost.js after #main, before </body>`);
}

(async () => {
    // ── / : in-process render ───────────────────────────────────────────────────
    const a = home.render({ releaseId: 'aaaaaaaaaaaa' });
    const html = a.html;
    boosted(html, '/', 'aaaaaaaaaaaa');
    assert.strictEqual(count(html, '</head>'), 1, 'exactly one </head>');
    assert.strictEqual((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one <h1>');
    const open = html.indexOf('<main id="main">'), close = html.indexOf('</main>');
    for (const [what, at] of [['the hero', html.indexOf('<section class="hero">')], ['the intents', html.indexOf('<ul class="intents"')], ['the constellation', html.indexOf('<div class="hero-sky">')], ['the <h1>', html.indexOf('<h1>')]]) {
        assert.ok(at > 0 && at < open, `${what} stays outside #main`);
    }
    for (const [what, at] of [['the home body', html.indexOf('aria-labelledby="h-now"')], ['the sites', html.indexOf('id="network"')], ['the shipped strip', html.indexOf('id="ov-shipped"')]]) {
        assert.ok(at > open && at < close, `${what} is inside #main`);
    }
    assert.ok(close < html.indexOf('<footer'), '#main closes before the footer');

    // A deploy changes the marker and so the ETag; the same release is the same cached page.
    const b = home.render({ releaseId: 'bbbbbbbbbbbb' });
    assert.notStrictEqual(b.etag, a.etag, 'a new release id changes the / ETag');
    assert.ok(b.html.includes('content="network@bbbbbbbbbbbb"'));
    assert.strictEqual(home.render({ releaseId: 'bbbbbbbbbbbb' }).etag, b.etag, 'the same release keeps its ETag');

    // ── the hero's intent picker (its inline script, over the rendered intents) ─
    const intents = [...html.matchAll(/<a class="intent" href="([^"]+)" data-id="([^"]+)" data-k="([^"]*)"/g)].map(([, href, id, k]) => {
        const classes = new Set();
        return { href, id, classes, getAttribute: (n) => ({ 'data-id': id, 'data-k': k }[n]), classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
    });
    assert.ok(intents.length > 5, 'the intents render');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("'.intent-bar'"));
    assert.ok(script, 'the intent picker script is on the page');
    const on = {};
    const target = (name) => ({ addEventListener: (type, fn) => { on[`${name}:${type}`] = fn; } });
    const form = target('form'), q = { ...target('q'), value: '' };
    const location = { href: '/' };
    vm.runInNewContext(script, { location, document: { querySelector: (s) => (s === '.intent-bar' ? form : null), getElementById: (id) => (id === 'intent-q' ? q : null), querySelectorAll: (s) => (s === '.intent' ? intents : []) } });
    const byId = (id) => intents.find((i) => i.id === id);
    q.value = 'go live'; on['q:input']();
    assert.ok(byId('live').classes.has('match'), '"go live" lights the live intent');
    assert.ok(byId('chat').classes.has('dim') && !byId('live').classes.has('dim'), 'the others dim');
    let prevented = false;
    on['form:submit']({ preventDefault: () => { prevented = true; } });
    assert.ok(prevented && location.href === byId('live').href, 'Enter opens the intent it names');
    q.value = ''; on['q:input']();
    assert.ok(intents.every((i) => !i.classes.has('dim') && !i.classes.has('match')), 'an empty search clears the picker');
    q.value = 'merge pdf'; prevented = false; on['form:submit']({ preventDefault: () => { prevented = true; } });
    assert.ok(!prevented, 'a tool search stays the form\'s own openvibe.tools search');

    // ── /status and /updates: the route factories get the release ──────────────
    const release = { release: 'cccccccccccc' };
    const ecosystem = { current: () => [], lastPollAt: () => null, pollMs: 60000, releaseHealthSince: () => null };
    const feed = { entries: [{ service: 'wiki', sha: 'a'.repeat(40), short: 'aaaaaaa', subject: 'x', deployed_at: '2026-10-13T07:00:00.000Z', url: 'https://github.com/OpenVibers/OpenVibe.Wiki/commit/aaa' }], posts: [] };
    const app = express();
    app.use(createStatusRoutes({ ecosystem, release }));
    app.use(createUpdatesRoutes({ release, fetchImpl: async () => ({ ok: true, json: async () => feed }), log: null }).router);
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
        const status = await (await fetch(`${base}/status`)).text();
        boosted(status, '/status', 'cccccccccccc');
        assert.ok(status.indexOf('<h1>Service status</h1>') > status.indexOf('id="main"'), '/status: its body is inside #main');
        for (const url of ['/updates', '/updates?site=wiki']) {
            const up = await (await fetch(base + url)).text();
            boosted(up, url, 'cccccccccccc');
            const m = up.indexOf('id="main"'), shipped = up.indexOf('data-ov-shipped="log"');
            assert.ok(shipped > m && shipped < up.indexOf('</main>'), `${url}: the log (and its loading line) is inside #main`);
            assert.ok(/addEventListener\('ov:boost:load',function\(\)\{if\(window\.OpenVibeShipped\)OpenVibeShipped\.scan\(document\.getElementById\('main'\)\)/.test(up), `${url}: the log re-mounts after a swap`);
        }
    } finally {
        srv.close();
    }
    console.log('boost: / /status /updates carry the marker, #main and boost.js');
})().catch((err) => { console.error(err); process.exitCode = 1; });
