'use strict';
// The front door's crawl files (plan T11 lane D, audit §5 item 8): /robots.txt and /sitemap.xml are
// generated from openvibe-shared/seo rather than served as static files, so a crawler is told about the
// sitemap and gets lastmods that come from the release, not from the clock at request time.
//   node test/seo-routes.test.js
const assert = require('assert');
const { bootServer } = require('./helpers/boot-server');
const seo = require('openvibe-shared/seo');
const seoRoutes = require('../server/seo/routes');

(async () => {
    const srv = await bootServer();
    try {
        const get = (p) => fetch(srv.base + p).then(async r => ({ status: r.status, type: r.headers.get('content-type') || '', body: await r.text() }));

        // ── /robots.txt ──
        const robots = await get('/robots.txt');
        assert.strictEqual(robots.status, 200, '/robots.txt is 200');
        assert.ok(robots.type.startsWith('text/plain'), `/robots.txt is text/plain (got ${robots.type})`);
        assert.ok(/^User-agent: \*/m.test(robots.body), 'robots.txt has the default group');
        assert.ok(/^Allow: \/$/m.test(robots.body), 'robots.txt allows the root');
        assert.ok(!robots.body.includes('Disallow:'), 'robots.txt allows all paths and crawlers');
        for (const bot of seo.AI_AND_SEARCH_BOTS) assert.ok(robots.body.includes(`User-agent: ${bot}`), `robots.txt names ${bot}`);
        assert.ok(robots.body.includes('Sitemap: https://openvibe.network/sitemap.xml'), 'robots.txt points at the sitemap');
        for (const line of robots.body.split('\n')) if (line) assert.ok(/^[A-Za-z-]+: /.test(line), `every robots.txt line is a directive (got "${line}")`);

        // ── /sitemap.xml ──
        const sitemap = await get('/sitemap.xml');
        assert.strictEqual(sitemap.status, 200, '/sitemap.xml is 200');
        assert.ok(sitemap.type.startsWith('application/xml'), `/sitemap.xml is application/xml (got ${sitemap.type})`);
        assert.ok(sitemap.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'the sitemap has the XML declaration');
        const opened = (body) => {
            const tags = [...body.matchAll(/<(\/?)([a-z0-9]+:?[a-z0-9]*)\b[^>]*>/g)];
            const stack = [];
            for (const [, closing, name] of tags) {
                if (closing) { assert.strictEqual(stack.pop(), name, `the sitemap closes <${name}>`); } else if (!/^<\?/.test(name)) stack.push(name);
            }
            assert.deepStrictEqual(stack, [], 'the sitemap has no unclosed tags');
        };
        opened(sitemap.body);
        assert.ok(sitemap.body.includes('<loc>https://openvibe.network/</loc>'), 'the sitemap lists the home page');
        assert.ok(sitemap.body.includes('<lastmod>'), 'every entry carries a lastmod');
        const locs = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
        assert.deepStrictEqual(locs, seoRoutes.PAGES.map(p => `${seoRoutes.HOST}${p.path}`), 'the sitemap lists exactly the public HTML pages');
        assert.ok(locs.includes('https://openvibe.network/status'), 'the sitemap lists the status page');
        assert.ok(!locs.some(l => /\/admin|\/login/.test(l)), 'private pages are not in the sitemap');
        const lastmods = new Set([...sitemap.body.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(m => m[1]));
        assert.strictEqual(lastmods.size, 1, 'one lastmod for the whole sitemap');
        assert.ok(/^\d{4}-\d{2}-\d{2}$/.test([...lastmods][0]), 'lastmod is a date, not a timestamp');

        // ── lastmod is the release, not the request clock ──
        const again = await get('/sitemap.xml');
        assert.strictEqual(again.body, sitemap.body, 'two requests a moment apart produce the same sitemap');
        const shipped = seoRoutes.sitemapXml({ release: { full: () => ({ released_at: '2026-01-02T03:04:05Z' }) } });
        assert.ok(shipped.includes('<lastmod>2026-01-02</lastmod>'), 'lastmod follows the release manifest');

        console.log('seo routes: all checks passed');
    } catch (err) {
        console.error(srv.logs());
        throw err;
    } finally {
        await srv.stop();
    }
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
