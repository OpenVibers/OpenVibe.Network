'use strict';
// The front door's crawl files (plan T11 lane D, audit §5 item 8): /robots.txt and /sitemap.xml are
// generated from openvibe-shared/seo rather than served as static files, so a crawler is told about the
// sitemap and gets lastmods that come from the release, not from the clock at request time.
//   node test/seo-routes.test.js
const assert = require('assert');
const { bootServer } = require('./helpers/boot-server');
const seo = require('openvibe-shared/seo');
const seoRoutes = require('../server/seo/routes');
const render = require('../server/home/render');
const cache = require('openvibe-shared/cache-policy');

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
        // A directive, or a comment (Shared 4.13's content-signals note says what the site allows in words).
        for (const line of robots.body.split('\n')) if (line) assert.ok(/^[A-Za-z-]+: /.test(line) || line.startsWith('#'), `every robots.txt line is a directive or a comment (got "${line}")`);

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
        assert.ok(!locs.includes('https://openvibe.network/status'), 'not the status page: live, and noindex');
        assert.ok(!locs.some(l => /\/admin|\/login/.test(l)), 'private pages are not in the sitemap');
        const lastmods = new Set([...sitemap.body.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(m => m[1]));
        assert.strictEqual(lastmods.size, 1, 'one lastmod for the whole sitemap');
        assert.ok(/^\d{4}-\d{2}-\d{2}$/.test([...lastmods][0]), 'lastmod is a date, not a timestamp');

        // ── lastmod is the release, not the request clock ──
        const again = await get('/sitemap.xml');
        assert.strictEqual(again.body, sitemap.body, 'two requests a moment apart produce the same sitemap');
        const shipped = seoRoutes.sitemapXml({ release: { full: () => ({ released_at: '2026-01-02T03:04:05Z' }) } });
        assert.ok(shipped.includes('<lastmod>2026-01-02</lastmod>'), 'lastmod follows the release manifest');

        // ── /llms-full.txt: the public pages only, within maxBytes ──
        const full = await fetch(srv.base + '/llms-full.txt');
        const fullBody = await full.text();
        assert.strictEqual(full.status, 200, '/llms-full.txt is 200');
        assert.ok((full.headers.get('content-type') || '').startsWith('text/plain'), '/llms-full.txt is text/plain');
        assert.strictEqual(full.headers.get('cache-control'), cache.htmlHeaders({ maxAge: 3600 }), '/llms-full.txt is cached like /llms.txt');
        assert.ok(fullBody.startsWith('# OpenVibe Network\n'), 'llms-full.txt opens with the llms.txt header');
        const llms = await get('/llms.txt');
        assert.ok(fullBody.includes(llms.body.split('\n').find(l => l.startsWith('> '))), 'llms-full.txt carries the llms.txt summary');
        const fullUrls = [...fullBody.matchAll(/^URL: (\S+)$/gm)].map(m => m[1]);
        assert.deepStrictEqual(fullUrls, seoRoutes.PAGES.map(p => `${seoRoutes.HOST}${p.path}`), 'llms-full.txt lists exactly the sitemap pages');
        assert.ok(!/\/(admin|my|login|developer|internal|account|settings)\b/.test(fullUrls.join(' ')), 'no private page is listed');
        assert.ok(Buffer.byteLength(fullBody) <= render.LLMS_FULL_MAX_BYTES, 'llms-full.txt stays within maxBytes');
        assert.strictEqual(render.LLMS_FULL_MAX_BYTES, 512 * 1024);

        // ── the front door and /stats state they may be indexed (SEO-8) ──
        for (const p of ['/', '/stats']) {
            const page = await get(p);
            assert.strictEqual(page.status, 200, `${p} answers`);
            const head = page.body.slice(0, page.body.indexOf('</head>'));
            assert.ok(/<meta name="robots" content="index,\s*follow">/.test(head), `${p} says index, follow instead of relying on the crawler's default`);
        }

        // ── /sites: the hub of the whole network (SEO-9) ──
        const sitesPage = require('../server/sites/page');
        const { SITES } = require('../server/frame/sites');
        const openSites = SITES.filter((site) => site.status === 'open');
        const hub = await get('/sites');
        assert.strictEqual(hub.status, 200, '/sites answers 200 (it was a 404 before SEO-9)');
        assert.ok(hub.type.startsWith('text/html'), '/sites is HTML');
        const hubHead = hub.body.slice(0, hub.body.indexOf('</head>'));
        assert.strictEqual((hub.body.match(/<h1[ >]/g) || []).length, 1, '/sites has exactly one <h1>');
        assert.ok(/<link rel="canonical" href="https:\/\/openvibe\.network\/sites">/.test(hubHead), '/sites is its own canonical');
        assert.ok(/<meta name="robots" content="index,\s*follow">/.test(hubHead), '/sites says index, follow');
        assert.ok(hubHead.includes(`<title>All ${openSites.length} OpenVibe sites · OpenVibe.Network</title>`), 'the title carries the real count');
        assert.ok(/<meta name="description" content="[^"]{50,170}">/.test(hubHead), '/sites has a real description');
        assert.ok(/<meta property="og:image" content="https:\/\/openvibe\.network\/shared\/social\/network\.jpg\?v=/.test(hubHead), '/sites carries the network share card (an indexable page without og:image is an audit finding)');
        assert.ok(/<meta name="twitter:card" content="summary_large_image">/.test(hubHead), '/sites has a large share card');
        const hubLd = JSON.parse(hub.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
        assert.strictEqual(hubLd['@type'], 'CollectionPage', 'the JSON-LD is a CollectionPage');
        assert.strictEqual(hubLd.mainEntity['@type'], 'ItemList', 'with an ItemList');
        assert.strictEqual(hubLd.mainEntity.numberOfItems, openSites.length, 'the ItemList holds every open site');
        const ids = new Set(openSites.map((site) => `https://${site.host}/`));
        for (const item of hubLd.mainEntity.itemListElement) {
            assert.ok(ids.has(item.url), `${item.url} is an open site`);
            assert.ok(item.name && item.description, `${item.url} carries its name and its one-line purpose`);
        }
        assert.deepStrictEqual(hubLd.mainEntity.itemListElement.map((i) => i.url).sort(), [...ids].sort(), 'every open site is in the ItemList, and nothing else');
        // The home's ids: each site is anchored at the registry id the home groups it by, and links to its own home.
        for (const site of openSites) {
            assert.ok(hub.body.includes(`class="sc-card" id="${site.id}" href="https://${site.host}/"`), `/sites#${site.id} links to https://${site.host}/`);
        }
        // The groups are the home's six neighbourhoods, in the home's order, with a jump list to each.
        const { GROUPS, groupOf } = require('../server/frame/sites');
        const groupIds = GROUPS.map((g) => g.id).filter((id) => openSites.some((site) => groupOf(site.id) === id));
        assert.deepStrictEqual([...hub.body.matchAll(/<section class="sc-sec" id="(group-[a-z]+)" aria-labelledby=/g)].map((m) => m[1]), groupIds.map((id) => `group-${id}`), 'the groups appear once each, in the home order');
        for (const id of groupIds) assert.ok(hub.body.includes(`<a href="#group-${id}">`), `the jump list reaches #group-${id}`);
        // One page, one id: the site anchors and the group anchors never collide (a group "games" is a site "games").
        const pageIds = [...hub.body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
        assert.deepStrictEqual(pageIds.filter((id, i) => pageIds.indexOf(id) !== i), [], 'no id repeats on the page');
        // Only `open`: an entry that is not open never reaches the page or its ItemList.
        const one = openSites[0];
        const closed = sitesPage.render({ sites: SITES.map((site) => (site.id === one.id ? { ...site, status: 'soon' } : site)) });
        assert.ok(!closed.includes(`id="${one.id}"`), 'a site that is not open is not anchored on the page');
        assert.strictEqual(JSON.parse(closed.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]).mainEntity.numberOfItems, openSites.length - 1, 'and not in the ItemList');
        // Findable: the sitemap lists it, and llms-full.txt carries its list.
        assert.ok(locs.includes('https://openvibe.network/sites'), 'the sitemap lists /sites');
        assert.ok(fullBody.includes('URL: https://openvibe.network/sites'), 'llms-full.txt lists /sites');
        assert.ok(fullBody.includes(`${one.name} (https://${one.host}/)`) || fullBody.includes(`OpenVibe.${one.name} (https://${one.host}/)`), 'llms-full.txt carries the site list under /sites');

        // ── IndexNow: no INDEXNOW_KEY → no key file ──
        const KEY = require('crypto').randomBytes(16).toString('hex');
        assert.strictEqual((await get(`/${KEY}.txt`)).status, 404, 'no key file is served without INDEXNOW_KEY');

        console.log('seo routes: all checks passed');
    } catch (err) {
        console.error(srv.logs());
        throw err;
    } finally {
        await srv.stop();
    }

    // ── IndexNow: INDEXNOW_KEY set → /<key>.txt answers with the key ──
    const KEY = require('crypto').randomBytes(16).toString('hex');
    const keyed = await bootServer({ child: true, env: { INDEXNOW_KEY: KEY } });
    try {
        const r = await fetch(`${keyed.base}/${KEY}.txt`);
        assert.strictEqual(r.status, 200, 'the IndexNow key file is served');
        assert.ok((r.headers.get('content-type') || '').startsWith('text/plain'), 'the key file is text/plain');
        assert.strictEqual(await r.text(), KEY, 'the key file holds the key');
        assert.strictEqual((await fetch(`${keyed.base}/0000000000000000.txt`)).status, 404, 'another key is not served');
        assert.strictEqual((await fetch(`${keyed.base}/robots.txt`)).status, 200, 'robots.txt still answers');
    } catch (err) {
        console.error(keyed.logs());
        throw err;
    } finally {
        await keyed.stop();
    }
    console.log('seo routes: indexnow key file checks passed');
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
