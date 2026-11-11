'use strict';
// People's own controls, stage 1 (design 2026-11-11, piece 4): the active layout per surface and
// device, saved layouts, share links, the gallery and copying, the service read, the AI suggestion
// proxy, account export/deletion and network.layout.changed@1.
//   node --import ./test/helpers/pg-preload.mjs test/layouts.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { serviceAuth, validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const authRoutes = require('../server/auth/routes');
const accountData = require('../server/identity/account-data');
const layoutsMod = require('../server/layouts');

(async () => {
const db = getDb();
const log = console.log; console.log = () => {};

const mk = async (name) => {
    const id = (await db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?) RETURNING id').run(name, `${name}@example.test`, 'x', name)).lastInsertRowid;
    await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
const ana = await mk('layoutana');
const bob = await mk('layoutbob');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
const tokenOf = (u) => authRoutes.signToken(u, keys.privateKey, config);
const serviceToken = (cap, sub = 'svc:bot') => serviceAuth.signServiceToken({
    iss: config.jwt.issuer, sub, actor_type: 'service', aud: ['openvibe.network'], cap: [cap],
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: 'tok_layouts_test',
}, keys.privateKey);

const catalog = () => ({
    id: 'bot.controls', version: 1, name: 'Robot controls', devices: ['phone', 'tablet', 'computer'],
    grid: { columns: { phone: 4, tablet: 8, computer: 12 }, cell_px: { phone: 44, tablet: 44, computer: 44 } },
    theme_tokens: ['danger', 'surface', 'text'],
    parts: [
        { id: 'stop', name: 'Stop', kind: 'button', required: true, pressed: true, min: { w: 2, h: 2, px: 64 },
            styles: { tints: ['danger'], shapes: ['round', 'square'], opacity: { min: 0.7, max: 1 }, label: true },
            bindings: { keys: ['Space'], gamepad: ['south'] }, never_covers: [] },
        { id: 'stick', name: 'Drive stick', kind: 'stick', required: false, pressed: true, min: { w: 2, h: 2 },
            styles: { tints: ['surface'], shapes: ['round'], opacity: { min: 0.4, max: 1 }, label: false },
            bindings: { keys: ['W', 'A', 'S', 'D'], gamepad: ['left-stick'] }, never_covers: ['stop'] },
        { id: 'battery', name: 'Battery', kind: 'readout', required: false, pressed: false, min: { w: 1, h: 1 },
            styles: { tints: ['text'], shapes: ['pill'], opacity: { min: 0.4, max: 1 }, label: true },
            bindings: { keys: [], gamepad: [] }, never_covers: [] },
    ],
});
const part = (id, place) => ({
    id, visible: true, place,
    style: { tint: id === 'stop' ? 'danger' : id === 'stick' ? 'surface' : 'text', shape: id === 'stop' ? 'round' : id === 'battery' ? 'pill' : 'round', opacity: 1, label: id !== 'stick' },
    bindings: id === 'stop' ? { keys: ['Space'], gamepad: ['south'] } : id === 'stick' ? { keys: ['W', 'A', 'S', 'D'], gamepad: ['left-stick'] } : { keys: [], gamepad: [] },
});
const layout = (name = 'My phone controls') => ({
    surface: 'bot.controls', surface_version: 1, device: 'phone', name,
    author: { name: 'Ana' }, sharing: 'private',
    parts: [part('stop', { x: 0, y: 0, w: 2, h: 2 }), part('stick', { x: 0, y: 2, w: 2, h: 2 }), part('battery', { x: 2, y: 2, w: 1, h: 1 })],
});

let aiRequest = null;
let aiAnswer = null;
const suggestion = () => ({ ok: true, layout: { ...layout('Suggested'), id: undefined }, summary: 'Moved Stop to the left.', reasons: ['Stop stayed visible.'], receipt: { model: 'stub-1' } });
const layouts = layoutsMod.createLayouts({
    db, selfToken: () => 'test-service-token', fetchImpl: async (url, opts) => {
        aiRequest = { url, opts };
        if (aiAnswer) return aiAnswer;
        return { ok: true, status: 200, json: async () => suggestion() };
    },
});

const app = express();
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use(require('openvibe-contracts').http.middleware());
app.use('/api/v1/me/layouts', layoutsMod.router({ layouts, requireAuth }));
app.use('/api/v1/layouts', layoutsMod.publicRouter({ layouts, requireAuth }));
app.use('/api/v1/people', layoutsMod.serviceRouter({ layouts }));
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = (method, path, body, { token = tokenOf(ana), headers = {} } = {}) => fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }));
const active = '/api/v1/me/layouts/bot.controls?device=phone';
const outbox = async () => (await db.prepare("SELECT envelope FROM network_event_outbox WHERE (envelope->>'event_type') = 'network.layout.changed' ORDER BY id").all()).map((r) => r.envelope);
const clearOutbox = async () => { await db.prepare("DELETE FROM network_event_outbox WHERE (envelope->>'event_type') = 'network.layout.changed'").run(); };

try {
    // The migration is expand-only: an older release never reads the table.
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'migrations', '0077_ui_layouts.sql'), 'utf8'), /^-- phase: expand$/m);
    // No arrangement yet: 404 with a code the editor understands, never a made-up default.
    let r = await call('GET', active);
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.code, 'layout.none');
    r = await call('GET', active, undefined, { token: null });
    assert.strictEqual(r.status, 401, 'a session is needed to read a person’s layout');

    // A layout that hides Stop is refused with the SDK's plain reason; nothing is stored.
    const hidden = layout(); hidden.parts[0].visible = false;
    r = await call('PUT', active, { catalog: catalog(), layout: hidden });
    assert.strictEqual(r.status, 422, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'layout.invalid');
    assert.ok(r.body.reasons.includes('Stop has to stay visible.'), JSON.stringify(r.body.reasons));
    r = await call('GET', active);
    assert.strictEqual(r.status, 404, 'the refused layout was not stored');

    // The body must carry the catalog: validation is the SDK's, against a real surface.
    r = await call('PUT', active, { layout: layout() });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'layout.body_required');
    r = await call('PUT', active, { catalog: { ...catalog(), id: 'bot.overlay' }, layout: layout() });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.code, 'layout.surface_mismatch');

    // A complete arrangement is stored, active, with the store's id, revision and the person's name.
    await clearOutbox();
    r = await call('PUT', active, { catalog: catalog(), layout: layout() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.id, /^lay_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.strictEqual(r.body.revision, 1);
    assert.strictEqual(r.body.active, true);
    assert.strictEqual(r.body.sharing, 'private');
    assert.strictEqual(r.body.name, 'My phone controls');
    assert.strictEqual(r.body.author.name, 'layoutana');
    assert.deepStrictEqual(r.body.author.subject, { type: 'user', id: ana.subject_id });
    assert.ok(validate('ui.layout@1', r.body).valid);
    const firstId = r.body.id;
    r = await call('GET', active);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.id, firstId, 'the active layout reads back');
    let events = await outbox();
    assert.strictEqual(events.length, 1, 'one change event');
    assert.strictEqual(events[0].payload.change, 'active');
    assert.strictEqual(events[0].payload.layout_id, firstId);
    assert.strictEqual(events[0].subject.id, ana.subject_id);
    assert.strictEqual(events[0].subject.revision, 1);

    // Saving again updates the active row in place; a second PUT is a new revision and a new event.
    r = await call('PUT', active, { catalog: catalog(), layout: layout('One thumb') });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.id, firstId);
    assert.strictEqual(r.body.revision, 2);
    assert.strictEqual(r.body.name, 'One thumb');
    events = await outbox();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].payload.revision, 2);

    // Saved layouts: POST creates one beside the active, list answers both, rename moves only the name.
    r = await call('POST', '/api/v1/me/layouts', { catalog: catalog(), layout: layout('Saved one') });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.active, false);
    const savedId = r.body.id;
    r = await call('GET', '/api/v1/me/layouts');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.layouts.length, 2);
    assert.strictEqual(r.body.layouts.find((x) => x.id === firstId).active, true, 'active first');
    r = await call('PATCH', `/api/v1/me/layouts/${savedId}`, { name: 'One hand' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.name, 'One hand');
    assert.strictEqual(r.body.revision, 2);
    assert.ok((await outbox()).some((e) => e.payload.change === 'renamed' && e.payload.layout_id === savedId));

    // Another person never sees or changes it.
    r = await call('GET', `/api/v1/me/layouts/${savedId}`, undefined, { token: tokenOf(bob) });
    assert.strictEqual(r.status, 404);
    r = await call('PATCH', `/api/v1/me/layouts/${savedId}`, { name: 'Mine now' }, { token: tokenOf(bob) });
    assert.strictEqual(r.status, 404);
    r = await call('DELETE', `/api/v1/me/layouts/${savedId}`, undefined, { token: tokenOf(bob) });
    assert.strictEqual(r.status, 404);

    // Activate swaps which one is active; reset returns to the product's default and keeps the saved row.
    r = await call('POST', `/api/v1/me/layouts/${savedId}/activate`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.active, true);
    let list = (await call('GET', '/api/v1/me/layouts')).body.layouts;
    assert.strictEqual(list.find((x) => x.id === firstId).active, false);
    assert.strictEqual(list.find((x) => x.id === savedId).active, true);
    r = await call('POST', '/api/v1/me/layouts/bot.controls/reset?device=phone');
    assert.strictEqual(r.status, 204);
    assert.strictEqual((await call('GET', active)).status, 404, 'reset removes the active arrangement');
    list = (await call('GET', '/api/v1/me/layouts')).body.layouts;
    assert.strictEqual(list.length, 2, 'reset keeps the saved layouts');
    assert.ok((await outbox()).some((e) => e.payload.change === 'reset'));

    // Share: a token and a read-only public answer with no account data; unshare makes it private.
    r = await call('POST', `/api/v1/me/layouts/${firstId}/share`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.layout.sharing, 'link');
    assert.match(r.body.token, /^[A-Za-z0-9_-]{24,64}$/);
    assert.strictEqual(r.body.url, `/api/v1/layouts/shared/${r.body.token}`);
    const shareToken = r.body.token;
    const shared = await call('GET', r.body.url, undefined, { token: null });
    assert.strictEqual(shared.status, 200);
    assert.strictEqual(shared.body.layout.author.name, 'layoutana');
    assert.strictEqual(shared.body.layout.author.subject, undefined, 'no account in a share link');
    assert.strictEqual(shared.body.layout.id, firstId);
    assert.strictEqual((await call('GET', '/api/v1/layouts/shared/nope', undefined, { token: null })).status, 404);
    r = await call('DELETE', `/api/v1/me/layouts/${firstId}/share`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.sharing, 'private');
    assert.strictEqual((await call('GET', `/api/v1/layouts/shared/${shareToken}`, undefined, { token: null })).status, 404, 'an unshared link is gone');

    // Gallery: publish, list publicly, copy into another person's account, unpublish.
    r = await call('POST', `/api/v1/me/layouts/${firstId}/publish`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.sharing, 'gallery');
    r = await call('GET', '/api/v1/layouts/gallery?surface=bot.controls&device=phone', undefined, { token: null });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.layouts.length, 1);
    assert.strictEqual(r.body.layouts[0].author.subject, undefined, 'the gallery carries no account');
    assert.strictEqual(r.body.layouts[0].id, firstId);
    r = await call('POST', `/api/v1/layouts/gallery/${firstId}/copy`, undefined, { token: tokenOf(bob) });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.author.subject.id, bob.subject_id);
    assert.strictEqual(r.body.active, false);
    assert.strictEqual(r.body.sharing, 'private');
    assert.match(r.body.name, /\(copy\)$/);
    const bobCopy = r.body.id;
    assert.strictEqual((await call('GET', '/api/v1/me/layouts', undefined, { token: tokenOf(bob) })).body.layouts.length, 1);
    r = await call('GET', '/api/v1/layouts/gallery?surface=bot.controls&device=phone', undefined, { token: null });
    assert.strictEqual(r.body.layouts.length, 1, 'copying does not publish the copy');
    r = await call('DELETE', `/api/v1/me/layouts/${firstId}/publish`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await call('GET', '/api/v1/layouts/gallery', undefined, { token: null })).body.layouts.length, 0);
    r = await call('POST', '/api/v1/layouts/gallery/nope/copy', undefined, { token: tokenOf(bob) });
    assert.strictEqual(r.status, 400, 'a gallery id has a shape');
    assert.strictEqual(typeof bobCopy, 'string');

    // Make the first layout active again for the product read.
    r = await call('PUT', active, { catalog: catalog(), layout: layout() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const activeAgain = r.body.id;
    // The service read: a first-party token with network.layout.read, naming the person.
    r = await call('GET', `/api/v1/people/${ana.subject_id}/layouts/bot.controls?device=phone`, undefined, { token: tokenOf(ana) });
    assert.strictEqual(r.status, 401, 'a person token does not open the service route');
    r = await call('GET', `/api/v1/people/${ana.subject_id}/layouts/bot.controls?device=phone`, undefined, { token: serviceToken('network.layout.read', 'svc:bot') });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.id, activeAgain);
    r = await call('GET', `/api/v1/people/${ana.subject_id}/layouts/bot.controls?device=phone`, undefined, { token: serviceToken('network.layout.read', 'svc:bot'), headers: { 'X-OV-Subject': bob.subject_id } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'layout.subject_mismatch');
    r = await call('GET', `/api/v1/people/${ana.subject_id}/layouts/bot.controls?device=phone`, undefined, { token: serviceToken('network.layout.read', 'svc:bot'), headers: { 'X-OV-Subject': ana.subject_id } });
    assert.strictEqual(r.status, 200);
    r = await call('GET', `/api/v1/people/${ana.subject_id}/layouts/bot.controls?device=phone`, undefined, { token: serviceToken('network.follows.read', 'svc:bot') });
    assert.strictEqual(r.status, 403, 'a service without the layout capability is refused');
    r = await call('GET', `/api/v1/people/usr_01JAB2C3D4E5F6G7H8J9K0MNPQ/layouts/bot.controls?device=phone`, undefined, { token: serviceToken('network.layout.read', 'svc:bot') });
    assert.strictEqual(r.status, 404);

    // The AI call goes through Network to OpenVibe.AI as the person, with the catalog and the words.
    aiRequest = null;
    await call('PUT', active, { catalog: catalog(), layout: layout() });
    r = await call('POST', '/api/v1/me/layouts/bot.controls/suggest?device=phone', { catalog: catalog(), layout: layout(), words: 'put Stop on the left and make it huge' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ok, true);
    assert.ok(aiRequest, 'OpenVibe.AI was called');
    assert.ok(aiRequest.url.endsWith('/api/v1/ui/layout/suggest'));
    assert.strictEqual(aiRequest.opts.headers['X-OV-Subject'], ana.subject_id);
    assert.strictEqual(aiRequest.opts.headers.authorization, 'Bearer test-service-token');
    assert.strictEqual(JSON.parse(aiRequest.opts.body).words, 'put Stop on the left and make it huge');
    r = await call('POST', '/api/v1/me/layouts/bot.controls/suggest?device=phone', { catalog: catalog(), words: '' });
    assert.strictEqual(r.status, 422, 'empty words are refused before a model call');
    aiAnswer = { ok: false, status: 502, json: async () => ({ detail: 'the model refused' }) };
    r = await call('POST', '/api/v1/me/layouts/bot.controls/suggest?device=phone', { catalog: catalog(), words: 'make it one thumb' });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.body.code, 'layout.ai_failed');
    aiAnswer = { ok: true, status: 200, json: async () => ({ nope: true }) };
    r = await call('POST', '/api/v1/me/layouts/bot.controls/suggest?device=phone', { catalog: catalog(), words: 'make it one thumb' });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.body.code, 'layout.ai_invalid');
    aiAnswer = null;

    // Account export carries the layouts; deletion removes them.
    const part = await accountData.networkPart(db, ana.id);
    const exported = part.files.find((f) => f.name === 'layouts.json');
    assert.ok(exported, 'layouts.json is in the export');
    assert.ok(exported.content.some((x) => x.id === firstId && x.doc.surface === 'bot.controls'));
    await accountData.scheduleDeletion(db, ana, { auth_time: Math.floor(Date.now() / 1000) }, 'layoutana');
    const deletion = await db.prepare("SELECT * FROM account_deletions WHERE user_id = ? AND status = 'scheduled'").get(ana.id);
    const erased = await accountData.erase(db, deletion);
    assert.ok(erased.ui_layouts >= 1, 'the layouts are erased with the account');
    assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM ui_layouts WHERE subject_id = ?').get(ana.subject_id)).n, 0);

    log('layouts: active, saved, share, gallery, service read, AI proxy, export and deletion passed');
} finally {
    await new Promise((r) => server.close(r));
}
})().catch((err) => { console.error(err); process.exit(1); });
