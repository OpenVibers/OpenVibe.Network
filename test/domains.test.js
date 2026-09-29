'use strict';
// Tool domains (server/domains/routes.js): who may add a host, what is refused, one canonical and one
// short host per tool, many mirrors and aliases, and the public list. The database is the process one
// (test/helpers/pg-preload.mjs); the old "rebuild a legacy table in place" drill is gone with SQLite
// (the schema is migrations/NNNN_*.sql now).
const express = require('express');
const assert = require('assert');
const { getDb } = require('../server/db/database');

process.env.OWNER_USERNAME = process.env.OWNER_USERNAME || 'alex';

(async () => {
const db = await getDb();
await db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'alex', 'x', 'admin'), (2, 'mod', 'x', 'admin') ON CONFLICT (id) DO NOTHING").run();

const { createDomainRoutes } = require('../server/domains/routes');
const { ownerName } = require('../server/auth/owner-guard');
const owner = ownerName();
const auth = (req, res, next) => {
    const w = req.headers['x-as'];
    if (!w) return res.status(401).json({ error: 'auth' });
    req.user = w === 'owner' ? { id: 1, username: owner, role: 'admin' } : { id: 2, username: 'mod', role: 'admin' };
    next();
};
const cat = { getCatalog: async () => ({ source: 'live', catalog: { tools: [{ id: 'yt', hosts: { canonical: 'youtube-downloader.openvibe.tools', short: 'yt.openvibe.tools', aliases: [] } }], families: [] } }) };
const r = await createDomainRoutes(db, auth, { catalog: cat, checkDomain: async () => ({ ok: true }) });
const app = express();
app.use(express.json());
app.use('/api/domains', r.publicRouter);
app.use('/api/admin/domains', r.adminRouter);
await new Promise((resolve) => {
    const s = app.listen(0, async () => {
        const b = 'http://127.0.0.1:' + s.address().port;
        const j = async (m, p, as, body) => {
            const x = await fetch(b + p, { method: m, headers: { 'content-type': 'application/json', ...(as ? { 'x-as': as } : {}) }, body: body ? JSON.stringify(body) : undefined });
            return { s: x.status, j: await x.json().catch(() => null) };
        };
        let x = await j('GET', '/api/admin/domains'); assert.equal(x.s, 401);
        x = await j('GET', '/api/admin/domains', 'admin'); assert.equal(x.s, 403, 'admin non-owner refused');
        x = await j('POST', '/api/admin/domains', 'admin', { tool_id: 'yt', host: 'evil.com', role: 'canonical' }); assert.equal(x.s, 403);
        x = await j('POST', '/api/admin/domains', 'owner', { tool_id: 'yt', host: 'YoutubeDownloadOnline.com', role: 'canonical' }); assert.equal(x.s < 300, true, JSON.stringify(x.j));
        x = await j('POST', '/api/admin/domains', 'owner', { tool_id: 'yt', host: 'other.com', role: 'canonical' }); assert.ok(x.s < 300);
        x = await j('POST', '/api/admin/domains', 'owner', { tool_id: 'nope', host: 'a.com', role: 'alias' }); assert.equal(x.s, 400);
        x = await j('POST', '/api/admin/domains', 'owner', { tool_id: 'yt', host: 'bad host/../', role: 'alias' }); assert.equal(x.s, 400);
        x = await j('POST', '/api/admin/domains', 'owner', { tool_id: 'yt', host: 'youtubedownloader.openvibe.tools', role: 'mirror' }); assert.ok(x.s < 300, 'mirror role accepted: ' + JSON.stringify(x.j));
        x = await j('POST', '/api/admin/domains', 'owner', { tool_id: 'yt', host: 'ytmirror.example.com', role: 'mirror' }); assert.ok(x.s < 300, 'a tool may have several mirrors');
        x = await j('GET', '/api/domains');
        assert.equal(x.j.domains.filter(d => d.role === 'canonical').length, 1);
        assert.equal(x.j.domains.filter(d => d.role === 'mirror').length, 2);
        console.log('audit rows', (await db.prepare('select count(*) c from audit_log').get()).c);
        console.log('domains: all checks passed');
        s.close();
        resolve();
    });
});
})().catch(err => { console.error(err); process.exit(1); });
