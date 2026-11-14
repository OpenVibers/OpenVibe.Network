'use strict';
// The Storage tab's cloud scan (server/admin/storage.js): Network asks OpenVibe.Media itself, with Network's own
// service token for openvibe.media and the owner's usr_ in X-OV-Subject — the way the owner settings proxy asks a
// service (server/admin/ai-config-proxy.js). A refusal comes back as words the owner can act on, never the raw
// provider error the panel used to print.
//   node test/admin-storage-cloud.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { router, MEDIA_AUDIENCE, MEDIA_CAPABILITY } = require('../server/admin/storage');

(async () => {
    const seen = [];
    let answer = { status: 200, body: { usage: { b2: { configured: true, bytes: 42 } }, costs: { totalStorageMonthly: 3 }, checkedAt: '2026-11-14T10:00:00Z' } };
    const media = http.createServer((req, res) => {
        seen.push({ url: req.url, auth: req.headers.authorization || null, subject: req.headers['x-ov-subject'] || null });
        res.writeHead(answer.status, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
    });
    await new Promise((resolve) => media.listen(0, '127.0.0.1', resolve));
    const mediaUrl = `http://127.0.0.1:${media.address().port}`;

    const app = express();
    const requireAuth = (req, res, next) => { req.user = { subject_id: String(req.headers['x-test-subject'] || '') }; next(); };
    app.use('/api/admin/storage', requireAuth, router({
        selfToken: (aud, caps) => `token-for-${aud}-${(caps || []).join(',')}`,
        services: { media: { internalUrl: mediaUrl } },
    }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const own = server.address().port;
    const call = async (subject) => {
        const res = await fetch(`http://127.0.0.1:${own}/api/admin/storage/cloud`, { headers: { 'x-test-subject': subject } });
        return await res.json();
    };

    // 1. The scan reaches Media with Network's own service token and the owner's subject.
    const ok = await call('usr_7QH4J8ZK2M9P3R6T1V0W5X8Y2A');
    assert.ok(ok.ok === true, 'the scan answers with the usage');
    assert.ok(ok.usage && ok.usage.b2 && ok.usage.b2.bytes === 42, 'the usage is passed through');
    assert.ok(seen.length === 1 && seen[0].url.includes('/api/v1/live/admin/storage/buckets'), 'Media is asked on its own tenant route');
    assert.ok(seen[0].auth && seen[0].auth.includes(MEDIA_AUDIENCE) && seen[0].auth.includes(MEDIA_CAPABILITY), 'the call carries Network service token for openvibe.media');
    assert.ok(seen[0].subject === 'usr_7QH4J8ZK2M9P3R6T1V0W5X8Y2A', "the owner's usr_ travels in X-OV-Subject");

    // 2. A refusal is words, not the provider's own sentence.
    answer = { status: 403, body: { code: 'capability.denied', detail: 'service tokens are not accepted on this route' } };
    const refused = await call('usr_7QH4J8ZK2M9P3R6T1V0W5X8Y2A');
    assert.ok(refused.ok === false, 'a refusal is not a scan');
    assert.ok(typeof refused.detail === 'string' && refused.detail.length > 20, 'the refusal has words to read');
    assert.ok(/billing page/.test(refused.detail), 'the panel says where the cloud usage really is');

    // 3. Nobody else may run the scan, and an unconfigured Media says so.
    const noActor = await call('');
    assert.ok(noActor.ok === false && noActor.code === 'actor.required', 'the scan runs for the owner');

    const bare = express();
    bare.use('/api/admin/storage', requireAuth, router({ selfToken: () => 't', services: {} }));
    const bareServer = await new Promise((resolve) => { const s = bare.listen(0, '127.0.0.1', () => resolve(s)); });
    const barePort = bareServer.address().port;
    const res = await fetch(`http://127.0.0.1:${barePort}/api/admin/storage/cloud`, { headers: { 'x-test-subject': 'usr_7QH4J8ZK2M9P3R6T1V0W5X8Y2A' } });
    const body = await res.json();
    assert.ok(body.ok === false && body.code === 'media.not_configured', 'an unconfigured Media says so');

    media.close();
    console.log('admin-storage-cloud: Network asks Media with its own service token and the owner subject, a refusal comes back in words');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
