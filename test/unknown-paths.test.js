'use strict';
// Unknown paths answer 404 (roadmap §2.5, D44): the apex no longer sends the account hub with 200 for
// any path. Boots the real server (test/helpers/boot-server.js) and checks that every real page keeps
// its 200 and that anything else is a 404: a small noindex page, or JSON under /api, /internal, /oauth.
//   node test/unknown-paths.test.js
const assert = require('assert');
const { bootServer } = require('./helpers/boot-server');
const { ACCOUNT_HUB_PATHS } = require('../server/not-found');

(async () => {
    const srv = await bootServer();
    try {
        const get = (p, opts = {}) => fetch(srv.base + p, { redirect: 'manual', ...opts }).then(async r => ({ status: r.status, type: r.headers.get('content-type') || '', robots: r.headers.get('x-robots-tag') || '', location: r.headers.get('location') || '', text: await r.text() }));

        // ── Real pages keep 200 ──
        const real = [
            '/', '/login', '/forgot-password', '/reset-password', '/admin', '/admin/settings', '/admin/analytics/overview',
            '/verify-email', '/status', '/sso/fanout', '/terms', '/privacy', '/dmca', '/llms.txt',
            '/robots.txt', '/sitemap.xml', '/manifest.webmanifest', '/assets/logo.svg', '/shared/navbar.js', '/shared/v1/navbar.js',
            '/openvibe-sw.js', '/release.json', '/.well-known/openvibe', '/.well-known/web-identity', '/api/health', '/api/brand',
            '/api/v1/registry/services', '/api/v1/registry/categories', '/api/v1/registry/featured', '/api/.well-known/jwks',
            ...ACCOUNT_HUB_PATHS.filter(p => p !== '/my.html'),
        ];
        for (const p of real) {
            const r = await get(p);
            assert.strictEqual(r.status, 200, `${p} is a real page: 200 (got ${r.status})`);
        }
        assert.strictEqual((await get('/sso/check')).status, 400, '/sso/check is a route (400 without its parameters), not a 404');
        const hub = await get('/themes');
        assert.ok(hub.text.includes('<html') && !hub.text.includes('Page not found'), 'an account hub section is the account hub');
        // Redirects stay redirects.
        for (const [p, to] of [['/my.html', '/my'], ['/login.html', '/login'], ['/admin.html', '/admin'], ['/index.html', '/'], ['/tos', '/terms']]) {
            const r = await get(p);
            assert.ok((r.status === 301 || r.status === 302) && r.location === to, `${p} redirects to ${to} (got ${r.status} ${r.location})`);
        }

        // ── Everything else is a 404 ──
        for (const p of ['/nope', '/some/deep/path', '/developers', '/user/someone', '/my/extra', '/themes/x', '/problems/capability.denied', '/wp-login.php', '/@someone', '/assets/missing.png']) {
            const r = await get(p);
            assert.strictEqual(r.status, 404, `${p} answers 404 (got ${r.status})`);
            assert.ok(r.type.startsWith('text/html'), `${p}: the 404 is an HTML page`);
            assert.ok(/<meta name="robots" content="noindex">/.test(r.text) && /noindex/.test(r.robots), `${p}: the 404 page is noindex`);
            assert.ok(r.text.includes('Page not found') && r.text.includes('href="/"'), `${p}: the 404 page says so and links home`);
        }
        for (const p of ['/api/nope', '/api/v2/whatever', '/oauth/nope']) {
            const r = await get(p);
            assert.strictEqual(r.status, 404, `${p} answers 404`);
            assert.ok(r.type.includes('application/json') && JSON.parse(r.text).error === 'Not found', `${p}: a JSON 404`);
        }
        // Every method, not only GET.
        let r = await get('/nope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.strictEqual(r.status, 404, 'POST to an unknown path: 404');
        r = await get('/nope', { method: 'HEAD' });
        assert.strictEqual(r.status, 404, 'HEAD of an unknown path: 404');
        r = await get('/api/nope', { method: 'DELETE' });
        assert.strictEqual(r.status, 404, 'DELETE /api/nope: 404');

        console.log('unknown paths: all checks passed');
    } catch (err) {
        console.error(srv.logs());
        throw err;
    } finally {
        await srv.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
