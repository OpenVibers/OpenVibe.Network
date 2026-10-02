'use strict';
// Project placement (slice N3, docs/t2-cells-and-node-principal.md section 3.1 and decision A):
// migration 0015 adds dev_projects.preferred_regions; the project view returns home_cell, residency (derived from
// the home cell, never stored) and preferred_regions; PUT /:project/placement sets them. Admin+ membership only.
//   node test/project-placement.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../server/db/database');

(async () => {
const out = (...a) => console.log(...a);

const db = getDb();
await db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES
    (20, 'placer-owner', 'x', 'user'), (21, 'placer-dev', 'x', 'user'), (22, 'placer-stranger', 'x', 'user')`).run();

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const app = express();
app.use(express.json());
app.locals.db = db;
app.locals.config = {
    baseUrl: ISSUER, loginUrl: ISSUER, internalKey: 'legacy-key',
    jwt: { issuer: ISSUER, accessTokenExpiry: '1h' },
    developer: { sandboxAudiences: 'openvibe.media', sandboxAllowance: '', credentialOverlapS: 60 },
};
app.locals.privateKey = keys.privateKey;
app.locals.publicKey = keys.publicKey;
app.use('/api/v1/projects', require('../server/developer/routes').router());
const server = http.createServer(app);

const userToken = (id) => jwt.sign({ sub: id, id }, keys.privateKey, { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
const T = { owner: userToken(20), dev: userToken(21), stranger: userToken(22) };

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (who, method, p, body) => {
        const h = { ...(who ? { authorization: `Bearer ${T[who]}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) };
        const r = await fetch(`${base}/api/v1/projects${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
    };

    // ── Defaults: an existing and a new project both sit in wnam-1 (residency US) with no preferred regions ──
    let r = await api('owner', 'POST', '', { name: 'Existing' });
    assert.strictEqual(r.status, 201);
    const P = r.body.id;
    r = await api('owner', 'GET', `/${P}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.home_cell, 'wnam-1');
    assert.strictEqual(r.body.residency, 'US');
    assert.deepStrictEqual(r.body.preferred_regions, []);
    r = await api('owner', 'POST', '', { name: 'New' });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.home_cell, 'wnam-1');
    assert.strictEqual(r.body.residency, 'US');
    assert.deepStrictEqual(r.body.preferred_regions, []);
    // The column default is what made those empty arrays (0015), not the insert.
    const n = (await db.prepare("SELECT COUNT(*) AS n FROM dev_projects WHERE preferred_regions = '[]'").get()).n;
    assert.ok(n >= 2, 'every project defaults to an empty array');

    // A developer member may read the project but not place it.
    r = await api('owner', 'POST', `/${P}/members`, { username: 'placer-dev', role: 'developer' });
    assert.strictEqual(r.status, 201);

    // ── A valid update, and nothing else in the project read changes ──
    const before = await api('owner', 'GET', `/${P}`);
    r = await api('owner', 'PUT', `/${P}/placement`, { preferred_regions: ['us-west'] });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.preferred_regions, ['us-west']);
    assert.strictEqual(r.body.home_cell, 'wnam-1');
    assert.strictEqual(r.body.residency, 'US');
    r = await api('owner', 'GET', `/${P}`);
    assert.deepStrictEqual(r.body.preferred_regions, ['us-west']);
    const strip = (v) => { const { home_cell, residency, preferred_regions, ...rest } = v; return rest; };
    assert.deepStrictEqual(strip(r.body), strip(before.body), 'placement changes nothing else in the project read');
    const audited = await db.prepare("SELECT detail FROM dev_audit WHERE project_id = ? AND action = 'project.placement_changed'").all(P);
    assert.strictEqual(audited.length, 1);
    assert.deepStrictEqual(JSON.parse(audited[0].detail), { from: [], to: ['us-west'] });

    // ── Refusals: unknown region, too many, duplicates, a bad residency, a non-admin caller ──
    const refused = async (who, body, status, code, label) => {
        const x = await api(who, 'PUT', `/${P}/placement`, body);
        assert.strictEqual(x.status, status, `${label}: status`);
        assert.strictEqual(x.body.code, code, `${label}: code`);
    };
    await refused('owner', { preferred_regions: ['zz-mars'] }, 400, 'registry.unknown_region', 'unknown region');
    await refused('owner', { preferred_regions: ['us-west', 'us-east', 'eu-west', 'eu-central', 'ap-south', 'sa-east'] }, 400, 'registry.too_many_regions', 'six regions');
    await refused('owner', { preferred_regions: ['us-west', 'us-west'] }, 400, 'registry.duplicate_region', 'duplicates');
    await refused('owner', { preferred_regions: 'us-west' }, 400, 'project.invalid', 'not an array');
    await refused('owner', { preferred_regions: [], residency: 'ZZ' }, 400, 'registry.unknown_residency', 'bad residency');
    await refused('dev', { preferred_regions: ['us-west'] }, 403, 'project.forbidden', 'a member cannot place');
    r = await api('stranger', 'PUT', `/${P}/placement`, { preferred_regions: ['us-west'] });
    assert.strictEqual(r.status, 404, 'a non-member is not told the project exists');
    // None of those wrote.
    r = await api('owner', 'GET', `/${P}`);
    assert.deepStrictEqual(r.body.preferred_regions, ['us-west']);
    assert.strictEqual((await db.prepare("SELECT COUNT(*) AS n FROM dev_audit WHERE project_id = ? AND action = 'project.placement_changed'").get(P)).n, 1);

    // Residency may be stated when it agrees with the home cell (it is derived, never stored).
    r = await api('owner', 'PUT', `/${P}/placement`, { preferred_regions: ['us-west'], residency: 'US' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.residency, 'US');

    out('project placement: all checks passed');
    server.close();
})().catch(err => { console.error(err); process.exit(1); });
})().catch(err => { console.error(err); process.exit(1); });
