'use strict';
// The cache policy comes from openvibe-shared/cache-policy (plan T11 lane D): the /shared/<file> assets are
// content-addressed with ?v=<sha256 of the file>, so that exact version is immutable for a year while a
// wrong-but-hex ?v= or none at all gets five minutes plus a day of stale-while-revalidate (server/index.js,
// serveShared). /robots.txt, /sitemap.xml and /llms.txt are documents and take the HTML policy.
//   node test/asset-cache.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const cache = require('openvibe-shared/cache-policy');
const sharedFiles = require('openvibe-shared/files');
const { bootServer } = require('./helpers/boot-server');

(async () => {
    const srv = await bootServer();
    try {
        const get = (p) => fetch(srv.base + p).then(async (r) => ({ status: r.status, cache: r.headers.get('cache-control'), body: await r.text() }));

        const file = 'navbar.js';
        const version = crypto.createHash('sha256').update(fs.readFileSync(sharedFiles.path(file))).digest('hex').slice(0, 12);

        // The version the file's bytes hash to is content-addressed: immutable for a year.
        const pinned = await get(`/shared/${file}?v=${version}`);
        assert.strictEqual(pinned.status, 200, '/shared/navbar.js is 200');
        assert.strictEqual(pinned.cache, 'public, max-age=31536000, immutable');
        assert.strictEqual(pinned.cache, cache.IMMUTABLE);

        // A wrong-but-hex ?v= and no ?v= at all are not content-addressed: 5 minutes + a day of swr.
        for (const qs of ['?v=deadbeefdeadbeef', '']) {
            const r = await get(`/shared/${file}${qs}`);
            assert.strictEqual(r.status, 200, `/shared/navbar.js${qs} is 200`);
            assert.strictEqual(r.cache, 'public, max-age=300, stale-while-revalidate=86400');
            assert.strictEqual(r.cache, cache.assetHeaders(file, { hashed: false }));
        }

        // Crawl files are documents: the HTML policy at the same max-age.
        for (const p of ['/robots.txt', '/sitemap.xml', '/llms.txt']) {
            const r = await get(p);
            assert.strictEqual(r.status, 200, `${p} is 200`);
            assert.strictEqual(r.cache, cache.htmlHeaders({ maxAge: 3600 }), `${p} keeps the HTML cache policy`);
        }

        console.log('asset cache: ?v=<hash> is immutable for a year; a wrong or missing ?v= is 5 min + a day of swr');
    } catch (err) {
        console.error(srv.logs());
        throw err;
    } finally {
        await srv.stop();
    }
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
