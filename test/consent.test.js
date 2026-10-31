'use strict';
// The consent registry (L24, 2026-10-31; Contracts 0.256.0 network.consent@1): every use of a person's content or
// likeness for AI or data is off until that person turns it on. What this proves:
//   - on, off, then on again with other kinds makes two rows and three append-only events;
//   - a stale text version, a missing 18+ confirmation and a kind outside the purpose are refused;
//   - the check is false for an unknown, revoked or expired subject, and for another kind, client or feature;
//   - 501 subjects are refused, and the service route needs a token with network.consent.read;
//   - a check's active rows come from one query;
//   - the change event is emitted after the commit, and the outbox carries the contract's fields only;
//   - export keeps every row and every event; deletion revokes and keeps; merge revokes and never carries over;
//   - the account page's "Your data choices" has kit fold rows and nothing pre-ticked.
//   node --import ./test/helpers/pg-preload.mjs test/consent.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { ids, validate } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const principals = require('../server/identity/principals');
const consentMod = require('../server/consent');
const accountData = require('../server/identity/account-data');
const accountMerge = require('../server/identity/account-merge');

(async () => {
const db = getDb();
const log = console.log; console.log = () => {};
await principals.ensureSchema(db);

const mk = async (name, subjectId = null) => {
    const subject = subjectId || `usr_${ids.ulid()}`;
    const id = (await db.prepare('INSERT INTO users (username, email, password_hash, subject_id) VALUES (?, ?, ?, ?) RETURNING id')
        .run(name, `${name}@example.test`, 'x', subject)).lastInsertRowid;
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
const ana = await mk('consana');
const bob = await mk('consbob');
const unknown = `usr_${ids.ulid()}`;
const current = '2026-10-31.1';

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const authRoutes = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
const tokenOf = (u) => authRoutes.signToken(u, keys.privateKey, config);

const emitted = [];
const consent = consentMod.createConsent({ db, emit: async (payload) => {
    const v = validate('network.consent.changed@1', payload);
    assert.ok(v.valid, `the emitted payload is the contract's: ${JSON.stringify(v.errors)}`);
    assert.deepStrictEqual(Object.keys(payload).sort(), ['changed_at', 'client', 'consent_id', 'kinds', 'on', 'purpose', 'subject', 'text_version'], 'only the contract fields');
    emitted.push(payload);
} });

const app = express();
app.use(express.json());
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/api/v1/me/consent', consentMod.router({ consent, requireAuth }));
app.use('/internal/consent', principals.guard('network.consent.read'), consentMod.internalRouter({ consent }));
const server = http.createServer(app);

const outbox = async (subjectId) => (await db.prepare('SELECT envelope FROM network_event_outbox ORDER BY id').all())
    .map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope))
    .filter((e) => e.event_type === 'network.consent.changed' && (!subjectId || e.payload.subject === subjectId));

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const as = (u) => ({ authorization: `Bearer ${tokenOf(u)}` });
    const call = async (method, p, { user = ana, body, headers = {} } = {}) => {
        const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? as(user) : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json().catch(() => ({})) };
    };
    const serviceToken = async (client) => {
        await db.prepare('UPDATE oauth_clients SET client_secret = ? WHERE client_id = ?').run(`${client}-secret`, client);
        const out = await principals.issueToken(db, { clientId: client, clientSecret: `${client}-secret`, audience: 'openvibe.network', privateKey: keys.privateKey, issuer: config.jwt.issuer });
        assert.strictEqual(out.status, 200, `${client} token: ${JSON.stringify(out.body)}`);
        return out.body.access_token;
    };

    try {
        // ── The words are the owner's: nothing is "never", it is off until turned on. ──
        const ai = consentMod.PURPOSES.find((p) => p.id === 'ai.train');
        const pub = consentMod.PURPOSES.find((p) => p.id === 'data.public');
        assert.strictEqual(ai.allows, 'OpenVibe may train or fine-tune its models on the content you pick.');
        assert.strictEqual(ai.cannot_undo, 'A model already trained keeps what it learned.');
        assert.strictEqual(pub.allows, "Your content you pick goes into OpenVibe's open dataset, under the licence you choose.");
        assert.strictEqual(pub.cannot_undo, 'Copies already downloaded stay out there; the next release leaves your content out.');
        for (const p of consentMod.PURPOSES) assert.strictEqual(validate('network.me-consent-result@1', { purposes: [p], consents: [], history: [] }).valid, true, `${p.id} words fit the contract`);

        // ── A person: nothing is on at first ──
        let r = await call('GET', '/api/v1/me/consent');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.purposes.length, 4);
        assert.deepStrictEqual(r.body.consents, [], 'off by default');
        assert.deepStrictEqual(r.body.history, []);
        assert.strictEqual(r.cache, 'private, no-store');
        const m = validate('network.me-consent-result@1', r.body);
        assert.ok(m.valid, `mine validates: ${JSON.stringify(m.errors)}`);

        // The services that use content hold network.consent.read; none of these grants was ever revoked, so none
        // belongs in RESTORED_GRANTS (the rule at the top of principals.js).
        for (const svc of ['live', 'vision', 'ai', 'media-hub', 'cam', 'chat', 'actor']) {
            assert.ok(principals.DEFAULT_GRANTS.some((g) => g[0] === svc && g[1] === 'network.consent.read' && g[2] === principals.SELF_AUDIENCE), `${svc} may ask the check`);
            assert.ok(!principals.REVOKED_GRANTS.some((g) => g[0] === svc && g[1] === 'network.consent.read'), `${svc} is not a restored grant`);
        }

        // On.
        r = await call('PUT', '/api/v1/me/consent/ai.train', { body: { on: true, text_version: current, adult: true, kinds: ['streams'] } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.consents.length, 1);
        assert.strictEqual(r.body.consents[0].on, true);
        assert.deepStrictEqual(r.body.consents[0].kinds, ['streams']);
        assert.strictEqual(r.body.history.length, 1);
        assert.strictEqual(r.body.history[0].action, 'granted');
        assert.strictEqual(emitted.length, 1);
        assert.strictEqual(emitted[0].on, true);

        // Off: the row is revoked, never deleted.
        r = await call('PUT', '/api/v1/me/consent/ai.train', { body: { on: false } });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.consents, []);
        assert.strictEqual(r.body.history.length, 2);
        assert.strictEqual(r.body.history[0].action, 'revoked');
        assert.strictEqual(emitted.length, 2);
        assert.strictEqual(emitted[1].on, false);

        // On again with other kinds: a second row, three events in all (the first row is kept, revoked).
        r = await call('PUT', '/api/v1/me/consent/ai.train', { body: { on: true, text_version: current, adult: true, kinds: ['vods'] } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.consents.length, 1);
        assert.deepStrictEqual(r.body.consents[0].kinds, ['vods']);
        assert.strictEqual(r.body.history.length, 3);
        const rows = await db.prepare("SELECT * FROM consents WHERE subject = ? AND purpose = 'ai.train' ORDER BY granted_at").all(ana.subject_id);
        assert.strictEqual(rows.length, 2, 'two rows');
        assert.strictEqual(rows.filter((x) => x.revoked_at).length, 1, 'the first row is revoked, kept');
        const history = await db.prepare('SELECT action FROM consent_events WHERE subject = ? ORDER BY id').all(ana.subject_id);
        assert.deepStrictEqual(history.map((h) => h.action), ['granted', 'revoked', 'granted'], 'three append-only events');

        // The wording must be the one the page showed.
        r = await call('PUT', '/api/v1/me/consent/ai.train', { body: { on: true, text_version: '2020-01-01.1', adult: true } });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.body.code, 'consent.stale_text');

        // 18+ only for ai.train, data.public and face.recognize.
        r = await call('PUT', '/api/v1/me/consent/ai.train', { body: { on: true, text_version: current } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.body.code, 'consent.adult_required');

        // face.recognize takes no kinds.
        r = await call('PUT', '/api/v1/me/consent/face.recognize', { body: { on: true, text_version: current, adult: true, kinds: ['streams'] } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.body.code, 'consent.kind_not_allowed');

        // ── The check: true only for the active row that covers purpose, kind, client and feature. ──
        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('live')}` }, body: { purpose: 'ai.train', kind: 'vods', subjects: [ana.subject_id, unknown] } });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(r.body.allowed, { [ana.subject_id]: true, [unknown]: false }, 'unknown is false, never an error');
        assert.strictEqual(r.cache, 'no-store');
        const cv = validate('network.consent-check-result@1', r.body);
        assert.ok(cv.valid, JSON.stringify(cv.errors));

        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('live')}` }, body: { purpose: 'ai.train', kind: 'chat', subjects: [ana.subject_id] } });
        assert.deepStrictEqual(r.body.allowed, { [ana.subject_id]: false }, 'another kind is false');
        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('live')}` }, body: { purpose: 'ai.train', kind: 'vods', client: 'app-one', subjects: [ana.subject_id] } });
        assert.deepStrictEqual(r.body.allowed, { [ana.subject_id]: false }, "OpenVibe's own grant does not cover an app");

        // Revoked is false.
        await consent.choose({ subject: bob.subject_id }, 'ai.train', { on: true, text_version: current, adult: true, kinds: ['streams'] });
        await consent.choose({ subject: bob.subject_id }, 'ai.train', { on: false });
        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('live')}` }, body: { purpose: 'ai.train', kind: 'streams', subjects: [bob.subject_id] } });
        assert.deepStrictEqual(r.body.allowed, { [bob.subject_id]: false }, 'a revoked subject is false');

        // Expired is false before the sweep runs: every check computes it.
        const expired = await mk('consexp');
        const at = Date.now();
        await db.prepare(`INSERT INTO consents (id, subject, purpose, kinds, client, options, text_version, source, granted_at, expires_at)
            VALUES (?, ?, 'ai.train', ?, NULL, '{}', ?, 'account', ?, ?)`)
            .run(`cns_${ids.ulid(at)}`, expired.subject_id, ['streams'], current, new Date(at - 7200_000).toISOString(), new Date(at - 3600_000).toISOString());
        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('live')}` }, body: { purpose: 'ai.train', kind: 'streams', subjects: [expired.subject_id] } });
        assert.deepStrictEqual(r.body.allowed, { [expired.subject_id]: false }, 'an expired subject is false');
        assert.strictEqual(await consent.sweep(), 1, 'the sweep marks it');
        const expiredRow = await db.prepare("SELECT revoked_at, revoked_by FROM consents WHERE subject = ? AND purpose = 'ai.train'").get(expired.subject_id);
        assert.strictEqual(expiredRow.revoked_by, 'expired');
        assert.ok(expiredRow.revoked_at);
        const expiredEvent = await db.prepare("SELECT action FROM consent_events WHERE subject = ? AND action = 'expired'").get(expired.subject_id);
        assert.ok(expiredEvent, 'an expired event');
        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('live')}` }, body: { purpose: 'ai.train', kind: 'streams', subjects: [expired.subject_id] } });
        assert.deepStrictEqual(r.body.allowed, { [expired.subject_id]: false }, 'still false after the sweep');

        // Another client, and a feature: app.data names its client; face.recognize needs the feature.
        const appUser = await mk('consapp');
        await db.prepare(`INSERT INTO consents (id, subject, purpose, kinds, client, options, text_version, source, granted_at)
            VALUES (?, ?, 'app.data', ?, 'app-one', '{}', ?, 'oauth', ?)`)
            .run(`cns_${ids.ulid()}`, appUser.subject_id, ['streams'], current, new Date(at).toISOString());
        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('live')}` }, body: { purpose: 'app.data', kind: 'streams', client: 'app-one', subjects: [appUser.subject_id] } });
        assert.deepStrictEqual(r.body.allowed, { [appUser.subject_id]: true }, 'the named app is covered');
        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('live')}` }, body: { purpose: 'app.data', kind: 'streams', client: 'app-two', subjects: [appUser.subject_id] } });
        assert.deepStrictEqual(r.body.allowed, { [appUser.subject_id]: false }, 'another client is false');

        const faceUser = await mk('consface');
        await db.prepare(`INSERT INTO consents (id, subject, purpose, kinds, client, options, text_version, source, granted_at)
            VALUES (?, ?, 'face.recognize', '{}', NULL, ?, ?, 'account', ?)`)
            .run(`cns_${ids.ulid()}`, faceUser.subject_id, JSON.stringify({ features: ['verify'] }), current, new Date(at).toISOString());
        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('live')}` }, body: { purpose: 'face.recognize', feature: 'find', subjects: [faceUser.subject_id] } });
        assert.deepStrictEqual(r.body.allowed, { [faceUser.subject_id]: false }, 'another feature is false');
        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('live')}` }, body: { purpose: 'face.recognize', feature: 'verify', subjects: [faceUser.subject_id] } });
        assert.deepStrictEqual(r.body.allowed, { [faceUser.subject_id]: true }, 'the chosen feature is true');

        // data.public carries the licence of each allowed subject.
        const pubUser = await mk('conspub');
        await db.prepare(`INSERT INTO consents (id, subject, purpose, kinds, client, options, text_version, source, granted_at)
            VALUES (?, ?, 'data.public', '{}', NULL, ?, ?, 'account', ?)`)
            .run(`cns_${ids.ulid()}`, pubUser.subject_id, JSON.stringify({ licence: 'cc0-1.0' }), current, new Date(at).toISOString());
        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('live')}` }, body: { purpose: 'data.public', subjects: [pubUser.subject_id] } });
        assert.strictEqual(r.body.allowed[pubUser.subject_id], true);
        assert.strictEqual(r.body.licence[pubUser.subject_id], 'cc0-1.0');

        // ── The guard: no token, a token without the capability. ──
        const checkBody = { purpose: 'ai.train', kind: 'vods', subjects: [ana.subject_id] };
        r = await call('POST', '/internal/consent/check', { user: null, body: checkBody });
        assert.ok([401, 403].includes(r.status), `no token is refused (${r.status})`);
        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('quest')}` }, body: checkBody });
        assert.strictEqual(r.status, 403, 'a service without network.consent.read is refused');
        assert.strictEqual(r.body.code, 'capability.denied');

        // 501 subjects: the contract's limit, refused before any query.
        const tooMany = Array.from({ length: 501 }, () => `usr_${ids.ulid()}`);
        r = await call('POST', '/internal/consent/check', { user: null, headers: { authorization: `Bearer ${await serviceToken('live')}` }, body: { purpose: 'ai.train', subjects: tooMany } });
        assert.strictEqual(r.status, 400, 'at most 500 subjects a call');
        assert.strictEqual(r.body.code, 'consent.invalid');

        // ── The account: export keeps every row and every event. ──
        const part = await accountData.networkPart(db, ana.id);
        const file = part.files.find((f) => f.name === 'consents.json');
        assert.ok(file, 'consents.json is in the export');
        assert.strictEqual(file.content.consents.length, 2, 'every row, revoked included');
        assert.strictEqual(file.content.events.length, 3, 'every event');
        assert.ok(file.content.consents.every((x) => x.subject === ana.subject_id), "only ana's rows");
        const bobPart = await accountData.networkPart(db, bob.id);
        assert.ok(bobPart.files.find((f) => f.name === 'consents.json').content.consents.every((x) => x.subject === bob.subject_id), "only bob's");

        // ── Merge: the folded-in account's choices are revoked, never carried over. ──
        const survivor = await mk('conskeep');
        const folded = await mk('consfold');
        await consent.choose({ subject: survivor.subject_id }, 'ai.train', { on: true, text_version: current, adult: true, kinds: ['streams'] });
        await consent.choose({ subject: folded.subject_id }, 'ai.train', { on: true, text_version: current, adult: true, kinds: ['vods'] });
        await accountMerge.merge(db, folded, survivor, { initiatedBy: 'person' });
        const foldedActive = await db.prepare('SELECT COUNT(*) AS n FROM consents WHERE subject = ? AND revoked_at IS NULL').get(folded.subject_id);
        assert.strictEqual(foldedActive.n, 0, "the folded-in account's choice is revoked");
        const foldedRow = await db.prepare('SELECT revoked_by FROM consents WHERE subject = ?').get(folded.subject_id);
        assert.strictEqual(foldedRow.revoked_by, 'merge');
        const survivorActive = await db.prepare('SELECT kinds FROM consents WHERE subject = ? AND revoked_at IS NULL').get(survivor.subject_id);
        assert.deepStrictEqual(survivorActive.kinds, ['streams'], 'the survivor keeps its own');
        const mergeEvent = await db.prepare("SELECT action, \"by\" FROM consent_events WHERE subject = ? AND \"by\" = 'merge'").get(folded.subject_id);
        assert.ok(mergeEvent, 'the merge event is recorded');
        assert.ok((await outbox(folded.subject_id)).some((e) => e.payload.on === false), 'the merge change is emitted');

        // ── Deletion: revoke every active row, keep them. ──
        const gone = await mk('consgone');
        await consent.choose({ subject: gone.subject_id }, 'ai.train', { on: true, text_version: current, adult: true, kinds: ['clips'] });
        const delId = `del_${ids.ulid()}`;
        await db.prepare(`INSERT INTO account_deletions (id, user_id, subject, status, requested_at, delete_after) VALUES (?, ?, ?, 'scheduled', ?, ?)`)
            .run(delId, gone.id, gone.subject_id, '2026-10-30T12:00:00.000Z', '2026-11-29T12:00:00.000Z');
        await accountData.erase(db, await db.prepare('SELECT * FROM account_deletions WHERE id = ?').get(delId), { now: Date.parse('2026-11-29T12:00:00Z') });
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM consents WHERE subject = ? AND revoked_at IS NULL').get(gone.subject_id)).n, 0, 'no active row after deletion');
        const kept = await db.prepare('SELECT revoked_by FROM consents WHERE subject = ?').get(gone.subject_id);
        assert.ok(kept, 'the row is kept as proof');
        assert.strictEqual(kept.revoked_by, 'deletion');
        const delEvent = await db.prepare("SELECT action, \"by\" FROM consent_events WHERE subject = ? AND \"by\" = 'deletion'").get(gone.subject_id);
        assert.ok(delEvent, 'the deletion event is recorded');
        assert.ok((await outbox(gone.subject_id)).some((e) => e.payload.on === false), 'the deletion change is emitted');

        // ── The event is emitted after the commit: if it throws, the choice stays committed. ──
        const afterUser = await mk('consafter');
        let attempts = 0;
        const boom = consentMod.createConsent({ db, emit: async () => { attempts++; throw new Error('emit after commit'); } });
        await assert.rejects(() => boom.choose({ subject: afterUser.subject_id }, 'ai.train', { on: true, text_version: current, adult: true }), /emit after commit/);
        assert.strictEqual(attempts, 1, 'the emit ran');
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM consents WHERE subject = ? AND revoked_at IS NULL').get(afterUser.subject_id)).n, 1, 'the transaction had committed before the emit');

        // The default path queues network.consent.changed in Network's outbox, contract-shaped.
        const wire = consentMod.createConsent({ db });
        const wireUser = await mk('conswire');
        await wire.choose({ subject: wireUser.subject_id }, 'ai.train', { on: true, text_version: current, adult: true, kinds: ['code'] });
        const wired = await outbox(wireUser.subject_id);
        assert.strictEqual(wired.length, 1, 'one change event');
        assert.strictEqual(validate('events.event-envelope@1', wired[0]).valid, true);
        assert.strictEqual(validate('network.consent.changed@1', wired[0].payload).valid, true);
        assert.deepStrictEqual(wired[0].payload.kinds, ['code']);
        assert.strictEqual(wired[0].payload.on, true);
        assert.strictEqual(wired[0].visibility, 'internal');

        // ── 30 writes a minute per person. ──
        const busy = await mk('consbusy');
        for (let i = 0; i < 30; i++) await consent.choose({ subject: busy.subject_id }, 'ai.train', { on: false });
        await assert.rejects(() => consent.choose({ subject: busy.subject_id }, 'ai.train', { on: false }), (e) => e.status === 429 && e.code === 'consent.rate_limited');

        // ── The page: kit fold rows, nothing pre-ticked. ──
        const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'my.html'), 'utf8');
        assert.match(html, /id="consent-card"/);
        assert.match(html, /Your data choices/);
        assert.match(html, /href="\/shared\/kit\.css"/, 'the kit fold rows use the shared kit');
        const cardStart = html.indexOf('id="consent-card"');
        const card = html.slice(cardStart, html.indexOf('<div class="card">', cardStart));
        assert.ok(!/\bchecked\b/.test(card), 'nothing in the static card is pre-ticked');
        const pageJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'my', 'consent.js'), 'utf8');
        assert.match(pageJs, /class="ovk-fold consent-fold"/, 'one kit fold row per purpose');
        assert.match(pageJs, /I am 18 or older/, 'the 18+ confirmation is inside the row');
        assert.match(pageJs, /data-consent-on/);
        assert.match(pageJs, /data-consent-off/);
        assert.ok(!/checked\s*>/.test(pageJs), 'the checkbox markup itself is never pre-checked');
        assert.match(pageJs, /purpose\.kinds\.map/, 'the kinds are checkboxes');
        assert.match(pageJs, /consent-licence/, 'the licence select is there');
        assert.match(pageJs, /features are chosen in OpenVibe\.Vision/, 'Vision keeps the feature choice');
        assert.match(pageJs, /consentDoc\.history/, 'the history is listed');

        // ── The migration is expand-only, with the partial unique index and the purpose index. ──
        const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0033_consents.sql'), 'utf8');
        assert.match(sql, /^-- phase: expand$/m);
        assert.ok(!/\bDROP TABLE\b/i.test(sql), 'expand only');
        assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS consents_active[\s\S]*COALESCE\(client, ''\)[\s\S]*WHERE revoked_at IS NULL/);
        assert.match(sql, /CREATE INDEX IF NOT EXISTS consents_purpose_subject ON consents \(purpose, subject\)/);
        assert.match(sql, /CREATE TABLE IF NOT EXISTS consent_events/);
    } finally {
        server.close();
        console.log = log;
    }
    console.log('consent: ok');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
})().catch((e) => { console.error(e); process.exit(1); });
