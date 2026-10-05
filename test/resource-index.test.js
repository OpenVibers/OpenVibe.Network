'use strict';
// Network's authority resource index (ADR-048 section 3; capability network.resource.read):
// GET /api/v1/resources pages common.resource-summary@1 for the resources Network owns - its developer
// projects (prj_), their apps (app_) and its node principals (nod_) - and GET /api/v1/resources/:ovrn
// reads one by its computed ovrn. ?project=&kind=&cursor=&limit= are honoured; ?project= is the tenancy
// boundary, so a resource of another project is never returned. An ovrn is present exactly when
// openvibe-contracts' contracts.resources.nameOf composes one: never for a project (ADR-048: a project
// is addressed by its bare prj_ id), never for an app (app_ is excluded from the OVRN id pattern), and
// only for a project-owned node principal.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { validate, ids } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');
const resourceIndex = require('../server/registry/resource-index');

(async () => {
    const log = console.log; console.log = () => {};
    const db = getDb();
    console.log = log;
    await db.prepare("UPDATE oauth_clients SET client_secret = 'host-secret' WHERE client_id = 'host'").run();
    await db.prepare("UPDATE oauth_clients SET client_secret = 'live-secret' WHERE client_id = 'live'").run();
    await db.prepare("INSERT INTO principal_grants (client_id, capability, audience, namespaces, granted_by) VALUES ('host', 'network.resource.read', 'openvibe.network', '[]', 'test') ON CONFLICT DO NOTHING").run();

    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.locals.db = db;
    app.locals.config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
    app.locals.privateKey = keys.privateKey;
    app.locals.publicKey = keys.publicKey;
    app.use('/oauth', require('../server/auth/oauth-routes'));
    app.use('/api/v1/resources', resourceIndex.router({ guard: principals.guard('network.resource.read') }));
    const server = http.createServer(app);

    // -- Fixtures: two projects, their apps, and platform-, project- and user-owned node principals --
    const prjA = ids.newId('project'); const prjB = ids.newId('project');
    const usrA = ids.newId('user'); const usrB = ids.newId('user');
    const appA = ids.newId('app'); const appA2 = ids.newId('app'); const appB = ids.newId('app');
    const nodA = ids.newId('node'); const nodB = ids.newId('node'); const nodP = ids.newId('node'); const nodU = ids.newId('node');
    const at = '2026-10-01T00:00:00Z';
    await db.prepare("INSERT INTO dev_projects (id, owner_subject, name, environment_policy, allowance, created_at, created_by) VALUES (?, ?, 'Project A', 'sandbox', '[]', ?, 'test')").run(prjA, usrA, at);
    await db.prepare("INSERT INTO dev_projects (id, owner_subject, name, environment_policy, allowance, created_at, created_by, archived_at, archived_by) VALUES (?, ?, 'Project B', 'sandbox', '[]', ?, 'test', ?, 'test')").run(prjB, usrB, at, at);
    const insertApp = db.prepare("INSERT INTO dev_apps (id, project_id, name, environment, oauth_client_id, client_type, created_at, created_by, revoked_at) VALUES (?, ?, ?, 'sandbox', ?, 'public', ?, 'test', ?)");
    await insertApp.run(appA, prjA, 'App A', appA, at, null);
    await insertApp.run(appA2, prjA, 'App A2', appA2, at, at);
    await insertApp.run(appB, prjB, 'App B', appB, at, null);
    const insertNode = db.prepare("INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, project_id, owner_subject, name, trust, status, created_by, credential_hash) VALUES (?, ?, 'wnam-1', ?, ?, ?, ?, ?, 'active', 'test', ?)");
    await insertNode.run(nodA, 'node-a', 'project', prjA, null, 'Machine A', 'community', 'a'.repeat(64));
    await insertNode.run(nodB, 'node-b', 'project', prjB, null, 'Machine B', 'community', 'b'.repeat(64));
    await insertNode.run(nodP, 'node-p', 'platform', null, null, 'Platform machine', 'first-party', null);
    await insertNode.run(nodU, 'node-u', 'user', null, usrA, "Person's machine", 'community', 'c'.repeat(64));

    const ovrnOfNode = (project, node) => `ovrn:network:${project}:node/${node}`;
    const expected = [];
    expected.push({ id: prjA, kind: 'network.project' }, { id: prjB, kind: 'network.project' });
    expected.push({ id: appA, kind: 'network.app' }, { id: appA2, kind: 'network.app' }, { id: appB, kind: 'network.app' });
    expected.push({ id: nodA, kind: 'network.node' }, { id: nodB, kind: 'network.node' }, { id: nodP, kind: 'network.node' }, { id: nodU, kind: 'network.node' });
    expected.sort((x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

    (async () => {
        await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
        const base = `http://127.0.0.1:${server.address().port}`;
        const token = async (id, secret, scope) => (await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, audience: 'openvibe.network', ...(scope ? { scope } : {}) }) })).json()).access_token;
        const auth = { authorization: `Bearer ${await token('host', 'host-secret')}` };
        const get = (url, headers) => fetch(`${base}${url}`, { headers }).then(async (y) => ({ status: y.status, headers: y.headers, body: await y.json().catch(() => null) }));
        try {
            assert.strictEqual((await get('/api/v1/resources')).status, 403, 'nobody');
            assert.strictEqual((await get('/api/v1/resources', { authorization: `Bearer ${await token('live', 'live-secret')}` })).status, 403, 'Live has no network.resource.read');
            const list = await get('/api/v1/resources', auth);
            assert.strictEqual(list.status, 200, JSON.stringify(list.body));
            assert.strictEqual(list.headers.get('cache-control'), 'private, max-age=60');

            assert.deepStrictEqual(Object.keys(list.body).sort(), ['next_cursor', 'resources'], 'the page carries only the contract fields');
            const pageCheck = validate('common.resource-list-result@1', list.body);
            assert.ok(pageCheck.valid, JSON.stringify(pageCheck.errors));
            list.body.resources.forEach((s) => assert.ok(validate('common.resource-summary@1', s).valid, `${s.id}: ${JSON.stringify(validate('common.resource-summary@1', s).errors)}`));
            assert.strictEqual(list.body.next_cursor, null, 'one page holds the whole index');
            assert.deepStrictEqual(list.body.resources.map((r) => [r.kind, r.id]), expected.map((r) => [r.kind, r.id]), 'all three kinds, sorted by (kind, id)');
            assert.deepStrictEqual([...new Set(list.body.resources.map((r) => r.service))], ['network']);

            const byId = new Map(list.body.resources.map((r) => [r.id, r]));
            assert.strictEqual(byId.get(nodA).ovrn, ovrnOfNode(prjA, nodA), 'a project-owned node principal is named');
            [prjA, prjB].forEach((id) => assert.ok(!('ovrn' in byId.get(id)), `${id}: a project has no self-referential OVRN`));
            [appA, appA2, appB].forEach((id) => assert.ok(!('ovrn' in byId.get(id)), `${id}: an app is an actor, never a resource name`));
            [nodP, nodU].forEach((id) => assert.ok(!('ovrn' in byId.get(id)), `${id}: without a project segment there is no name`));
            assert.strictEqual(byId.get(nodU).owner.id, usrA, 'a user-owned machine names its owner');
            assert.strictEqual(byId.get(prjB).state, 'archived', 'the project state follows archived_at');
            assert.strictEqual(byId.get(appA2).state, 'revoked', 'the app state follows revoked_at');

            const aIds = async (q, headers = auth) => {
                const y = await get(`/api/v1/resources${q}`, headers);
                assert.strictEqual(y.status, 200, `${q}: ${JSON.stringify(y.body)}`);
                assert.ok(validate('common.resource-list-result@1', y.body).valid);
                return y.body.resources.map((r) => r.id);
            };
            assert.deepStrictEqual((await aIds(`?project=${prjA}`)).sort(), [appA, appA2, nodA, prjA].sort(), 'project A: its apps and its machine, never platform/user nodes');
            assert.deepStrictEqual(await aIds(`?project=${prjB}`), [appB, nodB, prjB].sort(), 'project B is never mixed in');
            assert.deepStrictEqual(await aIds(`?project=${prjA}&kind=network.app`), [appA, appA2].sort(), 'kind narrows within the project');
            assert.deepStrictEqual((await aIds('?kind=network.node')).sort(), [nodA, nodB, nodP, nodU].sort(), 'kind = node lists every node principal');
            assert.deepStrictEqual(await aIds('?kind=network.project'), [prjA, prjB].sort(), 'kind = project lists the projects');
            assert.deepStrictEqual(await aIds('?kind=network.unknown'), [], 'an unknown kind is an empty page, not an error');
            assert.deepStrictEqual(await aIds(`?project=${ids.newId('project')}`), [], 'an unknown project has no resources');

            const seen = [];
            let cursor = null;
            let pages = 0;
            for (;;) {
                const y = await get(`/api/v1/resources?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, auth);
                assert.strictEqual(y.status, 200);
                assert.ok(validate('common.resource-list-result@1', y.body).valid);
                seen.push(...y.body.resources.map((r) => r.id));
                if (y.body.next_cursor === null) { assert.strictEqual(seen.length, expected.length, 'the cursor chain ends at the end'); break; }
                assert.ok(typeof y.body.next_cursor === 'string' && y.body.next_cursor !== '');
                cursor = y.body.next_cursor;
                if (++pages > 50) assert.fail('the cursor chain never ended');
            }
            assert.deepStrictEqual(seen, expected.map((r) => r.id), 'no duplicates, none skipped, order preserved');
            assert.deepStrictEqual(await aIds(`?project=${prjA}&limit=1000`), [appA, appA2, nodA, prjA].sort(), 'a large limit still pages one result');

            const one = await get(`/api/v1/resources/${encodeURIComponent(ovrnOfNode(prjA, nodA))}`, auth);
            assert.strictEqual(one.status, 200, JSON.stringify(one.body));
            assert.strictEqual(one.headers.get('cache-control'), 'private, max-age=60');
            assert.ok(validate('common.resource-summary@1', one.body).valid);
            assert.deepStrictEqual(one.body, byId.get(nodA), 'the same summary the list answers');
            const missing = [
                ['a project OVRN', `ovrn:network:${prjA}:project/${prjA}`],
                ['an app OVRN', `ovrn:network:${prjA}:app/${appA}`],
                ['a platform node', ovrnOfNode(prjA, nodP)],
                ['a user-owned node', ovrnOfNode(prjA, nodU)],
                ["another project's id", ovrnOfNode(prjB, nodA)],
                ['an unknown node', ovrnOfNode(prjA, ids.newId('node'))],
                ['a non-OVRN', 'nope'],
            ];
            for (const [why, name] of missing) {
                const y = await get(`/api/v1/resources/${encodeURIComponent(name)}`, auth);
                assert.strictEqual(y.status, 404, why);
                assert.strictEqual(y.headers.get('content-type'), 'application/problem+json', why);
                assert.strictEqual(y.body.code, 'resources.unknown_resource', why);
            }

            const bad = [['?project=nope', 'project not a prj_ id'], ['?limit=0', 'limit below one'], ['?limit=abc', 'limit not a number'], ['?limit=99999', 'limit over the cap'], ['?cursor=***', 'cursor not one this index issued']];
            for (const [q, why] of bad) {
                const y = await get(`/api/v1/resources${q}`, auth);
                assert.strictEqual(y.status, 400, why);
                assert.strictEqual(y.body.code, 'resources.bad_query', why);
            }
            console.log('resource index: all tests passed');
        } finally {
            server.close();
        }
    })().catch((err) => { console.error(err); process.exit(1); });
})().catch((err) => { console.error(err); process.exit(1); });
