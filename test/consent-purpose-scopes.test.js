'use strict';
// Apps ask for consent per purpose at sign-in (the consent plan's C4, 2026-11-07; Contracts 0.307.0
// network.consent-claim@1). What this proves:
//   - an unknown purpose (or the retired ai.looks) is refused with invalid_scope at authorize, client-info and confirm;
//   - nothing is pre-ticked: the screen's words carry no default, the step asks, and the page builds unticked boxes;
//   - signing in with every purpose refused works, and the token's claim is [];
//   - the token carries exactly the purposes granted (a first-party user token, its silent sign-in, and an app token);
//   - turning a purpose off on the account page removes it from the next token (a refresh);
//   - a refused purpose is not asked again for 30 days, is asked once they pass, and the person can ask for it sooner;
//   - one app never reads another app's grants: not on its screen, not in its token, not in the check.
//   node --import ./test/helpers/pg-preload.mjs test/consent-purpose-scopes.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const express = require('express');
const jwt = require('jsonwebtoken');
const contracts = require('openvibe-contracts');
const { ids, serviceAuth } = contracts;
const { getDb } = require('../server/db/database');
const consentMod = require('../server/consent');
const consentApps = require('../server/consent/apps');

(async () => {
const log = console.log; console.log = () => {};
const db = getDb();

const mk = async (name) => {
    const id = (await db.prepare('INSERT INTO users (username, email, password_hash, subject_id) VALUES (?, ?, ?, ?) RETURNING id')
        .run(name, `${name}@example.test`, 'x', `usr_${ids.ulid()}`)).lastInsertRowid;
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
};
const ana = await mk('scopeana');

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const config = {
    baseUrl: ISSUER, loginUrl: ISSUER,
    jwt: { issuer: ISSUER, accessTokenExpiry: '1h' },
    developer: { sandboxAudiences: 'openvibe.media', sandboxAllowance: '', credentialOverlapS: 60 },
};
const authRoutes = require('../server/auth/routes');
const requireAuth = require('../server/auth/session').makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
const session = (u) => authRoutes.signToken(u, keys.privateKey, config);

const emitted = [];
const consent = consentMod.createConsent({ db, emit: async (payload) => { emitted.push(payload); } });

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(require('cookie-parser')());
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey, consent });
app.use('/oauth', require('../server/auth/oauth-routes'));
app.use('/api/v1/projects', require('../server/developer/routes').router());
app.use('/api/v1/me/consent', consentMod.router({ consent, requireAuth }));
const server = http.createServer(app);

// Two OpenVibe sites (confidential first-party clients) and, below, two developer apps.
const SITE1 = 'scope-site-one';
const SITE2 = 'scope-site-two';
const SITE_URI = (c) => `https://${c}.example/auth/callback`;
for (const c of [SITE1, SITE2]) {
    await db.prepare('INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, is_first_party) VALUES (?, ?, ?, ?, 1)')
        .run(c, `${c}-secret`, `Site ${c}`, JSON.stringify([SITE_URI(c)]));
}
const ALL = 'profile consent:ai.train consent:data.public consent:app.data';
const TEXT = consentApps.APP_TEXT_VERSION;

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), location: r.headers.get('location') });
    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(json);
    const form = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(json);
    const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' }).then(json);
    const me = (method, p) => fetch(base + '/api/v1/me/consent' + p, { method, headers: { authorization: `Bearer ${session(ana)}` } }).then(json);

    // A first-party site's sign-in: /oauth/confirm, then /oauth/token.
    const siteConfirm = (client, scope, consentAnswer) => post('/oauth/confirm', {
        token: session(ana), client_id: client, redirect_uri: SITE_URI(client), scope, state: 'st',
        ...(consentAnswer === undefined ? {} : { consent: consentAnswer }),
    });
    const codeOf = (r) => new URL(r.body.redirect).searchParams.get('code');
    const siteToken = async (client, code) => {
        const t = await form('/oauth/token', { grant_type: 'authorization_code', client_id: client, client_secret: `${client}-secret`, code, redirect_uri: SITE_URI(client) });
        assert.strictEqual(t.status, 200, JSON.stringify(t.body));
        return t.body;
    };
    const claimsOf = (token) => jwt.verify(token, keys.publicKey, { algorithms: ['RS256'] });
    const rows = async (client) => await db.prepare('SELECT * FROM consents WHERE subject = ? AND client = ? ORDER BY granted_at, id').all(ana.subject_id, client);
    const refusals = async (client) => await db.prepare('SELECT * FROM consent_refusals WHERE subject = ? AND client = ? ORDER BY purpose').all(ana.subject_id, client);

    try {
        // ── The words: the family's purposes minus the retired ai.looks, read from the pinned Contracts ──
        const family = contracts.schema('network.consent@1').properties.purpose.enum;
        assert.deepStrictEqual([...consentApps.APP_PURPOSE_IDS], family.filter((p) => p !== 'ai.looks'), 'every purpose the family defines, except the retired one');
        for (const p of consentApps.APP_PURPOSES) {
            assert.ok(p.title && p.allows && p.text_version === TEXT, `${p.id} has plain words and the screen's version`);
            assert.ok(!('on' in p) && !('checked' in p) && !('default' in p), `${p.id} carries no default`);
        }

        // ══ 1. An unknown purpose is refused with invalid_scope ══
        let r = await get(`/oauth/authorize?${new URLSearchParams({ client_id: SITE1, redirect_uri: SITE_URI(SITE1), response_type: 'code', scope: 'profile consent:data.sell', state: 'xyz' })}`);
        assert.strictEqual(r.status, 302);
        let loc = new URL(r.location);
        assert.strictEqual(loc.origin + loc.pathname, SITE_URI(SITE1), 'the error goes back to the app');
        assert.strictEqual(loc.searchParams.get('error'), 'invalid_scope');
        assert.strictEqual(loc.searchParams.get('state'), 'xyz', 'with its state');
        r = await get(`/oauth/authorize?${new URLSearchParams({ client_id: SITE1, redirect_uri: SITE_URI(SITE1), response_type: 'code', scope: 'consent:ai.looks', state: 's' })}`);
        assert.strictEqual(new URL(r.location).searchParams.get('error'), 'invalid_scope', 'the retired ai.looks is not a purpose an app may ask for');
        r = await get(`/oauth/authorize?${new URLSearchParams({ client_id: SITE1, redirect_uri: SITE_URI(SITE1), response_type: 'code', scope: ALL, state: 's' })}`);
        assert.strictEqual(r.status, 302);
        loc = new URL(r.location);
        assert.strictEqual(loc.pathname, '/login', 'known purposes go on to the sign-in page');
        assert.strictEqual(loc.searchParams.get('scope'), ALL, 'with the purposes on the scope');
        r = await get(`/oauth/client-info?${new URLSearchParams({ client_id: SITE1, redirect_uri: SITE_URI(SITE1), scope: 'consent:nope' })}`);
        assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'invalid_scope');
        r = await siteConfirm(SITE1, 'profile consent:nope');
        assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, 'invalid_scope');
        r = await siteConfirm(SITE1, 'profile consent:ai.train consent:sell.it', { shown: ['ai.train'], allow: ['ai.train'], adult: true, text_version: TEXT });
        assert.strictEqual(r.status, 400, 'one unknown purpose refuses the whole request, even with an answer');
        assert.strictEqual(r.body.error, 'invalid_scope');
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).n, 0, 'no code for a refused request');
        assert.deepStrictEqual(await rows(SITE1), [], 'and nothing granted');

        // ══ 2. Nothing is pre-ticked ══
        r = await get(`/oauth/client-info?${new URLSearchParams({ client_id: SITE1, redirect_uri: SITE_URI(SITE1), scope: ALL })}`);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.body.purposes.map((p) => p.id), ['ai.train', 'data.public', 'app.data'], 'each purpose, in the family\'s order');
        assert.ok(r.body.purposes.every((p) => p.title && p.allows && !('on' in p) && !('checked' in p)), 'plain words, no default');
        r = await siteConfirm(SITE1, ALL);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.redirect, undefined, 'no code before the person answers');
        assert.deepStrictEqual(r.body.consent.ask.map((p) => p.id), ['ai.train', 'data.public', 'app.data'], 'every purpose is asked, separately');
        assert.deepStrictEqual(r.body.consent.granted, []);
        assert.strictEqual(r.body.consent.adult, false, 'the page asks for 18+ itself');
        assert.strictEqual(r.body.consent.text_version, TEXT);
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).n, 0);
        assert.deepStrictEqual(await rows(SITE1), [], 'showing the screen grants nothing');
        // The page itself: login.js askPurposes builds one unticked box per purpose.
        const page = runAskPurposes(r.body.consent);
        assert.strictEqual(page.boxes.length, 3);
        assert.ok(page.boxes.every((b) => b.type === 'checkbox' && b.checked === false), 'nothing is pre-ticked');
        assert.strictEqual(page.button.textContent, 'Continue without allowing any', 'continuing with nothing ticked is the plain default');
        assert.strictEqual(page.adultRow.hidden, false, 'the 18+ line shows for the 18+ purposes');
        assert.ok(!/\bchecked\b/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8').split('id="panel-purposes"')[1].split('<!-- Register Form')[0]), 'the panel\'s markup ticks nothing');

        // ══ 3. Signing in with every purpose refused works ══
        r = await siteConfirm(SITE1, ALL, { shown: ['ai.train', 'data.public', 'app.data'], allow: [], text_version: TEXT });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.ok(r.body.redirect && codeOf(r), 'a code with nothing allowed');
        let t = await siteToken(SITE1, codeOf(r));
        assert.deepStrictEqual(claimsOf(t.access_token).consent, [], 'the claim says none granted');
        assert.strictEqual(t.scope, 'profile', 'the token response names no consent scope that was not granted');
        assert.deepStrictEqual(await rows(SITE1), [], 'nothing granted');
        const refused = await refusals(SITE1);
        assert.deepStrictEqual(refused.map((x) => x.purpose), ['ai.train', 'app.data', 'data.public']);
        for (const x of refused) {
            const days = (new Date(x.quiet_until).getTime() - new Date(x.refused_at).getTime()) / 86400000;
            assert.strictEqual(days, 30, 'quiet for 30 days');
            assert.strictEqual(x.text_version, TEXT);
        }

        // ══ 4. The 30-day quiet period ══
        r = await siteConfirm(SITE1, ALL);
        assert.ok(r.body.redirect, 'a refused purpose is not asked again: the sign-in goes straight on');
        assert.strictEqual(r.body.consent, undefined);
        t = await siteToken(SITE1, codeOf(r));
        assert.deepStrictEqual(claimsOf(t.access_token).consent, [], 'and still grants nothing');
        // Day 29: still quiet. Day 31: asked again.
        const dayMs = 86400000;
        const shift = async (days) => await db.prepare('UPDATE consent_refusals SET refused_at = ?, quiet_until = ? WHERE subject = ? AND client = ?')
            .run(new Date(Date.now() - days * dayMs).toISOString(), new Date(Date.now() - days * dayMs + consentApps.QUIET_MS).toISOString(), ana.subject_id, SITE1);
        await shift(29);
        r = await siteConfirm(SITE1, ALL);
        assert.ok(r.body.redirect, 'still quiet on day 29');
        await shift(31);
        r = await siteConfirm(SITE1, ALL);
        assert.deepStrictEqual(r.body.consent.ask.map((p) => p.id), ['ai.train', 'data.public', 'app.data'], 'asked again once 30 days passed');
        // Refuse again; the person asks for one of them sooner on their account page ("Ask me next time").
        r = await siteConfirm(SITE1, ALL, { shown: ['ai.train', 'data.public', 'app.data'], allow: [], text_version: TEXT });
        assert.ok(r.body.redirect);
        let apps = await me('GET', '/apps');
        assert.strictEqual(apps.status, 200);
        const site1 = apps.body.apps.find((a) => a.client === SITE1);
        assert.deepStrictEqual(site1.quiet.map((q) => q.purpose), ['ai.train', 'data.public', 'app.data'], 'the account page lists the refusals');
        assert.strictEqual(site1.name, `Site ${SITE1}`);
        apps = await me('DELETE', `/app.data/${SITE1}/refusal`);
        assert.strictEqual(apps.status, 200);
        assert.deepStrictEqual(apps.body.apps.find((a) => a.client === SITE1).quiet.map((q) => q.purpose), ['ai.train', 'data.public']);
        r = await siteConfirm(SITE1, ALL);
        assert.deepStrictEqual(r.body.consent.ask.map((p) => p.id), ['app.data'], 'only the one the person opened again is asked');

        // ══ 5. The token carries exactly the purposes granted ══
        r = await siteConfirm(SITE2, ALL);
        assert.deepStrictEqual(r.body.consent.ask.map((p) => p.id), ['ai.train', 'data.public', 'app.data'], 'SITE1\'s answers do not count for SITE2');
        r = await siteConfirm(SITE2, ALL, { shown: ['ai.train', 'data.public', 'app.data'], allow: ['ai.train', 'app.data'], text_version: TEXT });
        assert.strictEqual(r.status, 422, '18+ purposes need the confirmation');
        assert.strictEqual(r.body.error, 'consent.adult_required');
        r = await siteConfirm(SITE2, ALL, { shown: ['ai.train', 'data.public', 'app.data'], allow: ['ai.train', 'app.data'], adult: true, text_version: '2026-10-31.1' });
        assert.strictEqual(r.status, 409, 'old words are refused');
        assert.deepStrictEqual(await rows(SITE2), [], 'neither refusal wrote anything');
        r = await siteConfirm(SITE2, ALL, { shown: ['ai.train', 'data.public', 'app.data'], allow: ['ai.train', 'app.data'], adult: true, text_version: TEXT });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        t = await siteToken(SITE2, codeOf(r));
        assert.deepStrictEqual(claimsOf(t.access_token).consent, ['ai.train', 'app.data'], 'exactly the granted purposes');
        assert.strictEqual(t.scope, 'profile consent:ai.train consent:app.data', 'the response scope names the granted ones only');
        const granted = await rows(SITE2);
        // One sign-in grants both at the same moment, so their order is the ids' random part: compare by purpose.
        assert.deepStrictEqual(granted.map((x) => [x.purpose, x.source, x.text_version, x.revoked_at]).sort((a, b) => a[0].localeCompare(b[0])),
            [['ai.train', 'oauth', TEXT, null], ['app.data', 'oauth', TEXT, null]], 'each grant is a row: who, which app, which purpose, when, the wording');
        assert.ok(granted.every((x) => x.subject === ana.subject_id && x.client === SITE2 && x.granted_at));
        assert.deepStrictEqual(emitted.filter((e) => e.client === SITE2 && e.on).map((e) => e.purpose).sort(), ['ai.train', 'app.data'], 'network.consent.changed for each grant');
        assert.deepStrictEqual((await refusals(SITE2)).map((x) => x.purpose), ['data.public'], 'the unticked one is a refusal');
        // A token that asked for fewer purposes carries fewer: the claim follows the request.
        r = await siteConfirm(SITE2, 'profile consent:app.data');
        t = await siteToken(SITE2, codeOf(r));
        assert.deepStrictEqual(claimsOf(t.access_token).consent, ['app.data'], 'only what this sign-in asked for');
        // A sign-in that asked for no purpose carries no claim at all.
        r = await siteConfirm(SITE2, 'profile');
        t = await siteToken(SITE2, codeOf(r));
        assert.strictEqual(claimsOf(t.access_token).consent, undefined, 'no consent scope, no claim');
        // The silent sign-in (prompt=none) asks nothing and carries the granted purposes.
        r = await get(`/oauth/authorize?${new URLSearchParams({ client_id: SITE2, redirect_uri: SITE_URI(SITE2), response_type: 'code', scope: ALL, state: 'q', prompt: 'none' })}`,
            { cookie: `ov_token=${session(ana)}` });
        assert.strictEqual(r.status, 302);
        const silentCode = new URL(r.location).searchParams.get('code');
        assert.ok(silentCode, r.location);
        t = await siteToken(SITE2, silentCode);
        assert.deepStrictEqual(claimsOf(t.access_token).consent, ['ai.train', 'app.data'], 'silent sign-in: the grants, nothing asked');

        // ══ 6. Revoking removes it from the next token ══
        r = await siteConfirm(SITE2, ALL);
        const first = await siteToken(SITE2, codeOf(r));
        assert.deepStrictEqual(claimsOf(first.access_token).consent, ['ai.train', 'app.data']);
        apps = await me('DELETE', `/ai.train/${SITE2}`);
        assert.strictEqual(apps.status, 200);
        assert.deepStrictEqual(apps.body.apps.find((a) => a.client === SITE2).granted.map((g) => g.purpose), ['app.data'], 'the account page shows it off');
        const history = await db.prepare("SELECT \"by\" FROM consent_events WHERE subject = ? AND client = ? AND purpose = 'ai.train' AND action = 'revoked'").all(ana.subject_id, SITE2);
        assert.deepStrictEqual(history.map((h) => h.by), ['person'], 'the person turned it off');
        const next = await form('/oauth/token', { grant_type: 'refresh_token', client_id: SITE2, client_secret: `${SITE2}-secret`, refresh_token: first.refresh_token });
        assert.strictEqual(next.status, 200, JSON.stringify(next.body));
        assert.deepStrictEqual(claimsOf(next.body.access_token).consent, ['app.data'], 'the next token (a refresh) leaves it out');
        assert.strictEqual(next.body.scope, 'profile theme consent:app.data');
        const checked = await consent.check({ purpose: 'ai.train', client: SITE2, subjects: [ana.subject_id] });
        assert.strictEqual(checked.allowed[ana.subject_id], false, 'and the check says no');
        // The account page's own ai.train row turned off never touches an app's grant, and the reverse.
        let mine = await me('GET', '');
        assert.ok(mine.body.consents.every((c) => c.client === SITE2), 'only app rows are active');

        // ══ 7. One app never reads another app's grants (developer apps) ══
        const projects = (method, p, body) => fetch(`${base}/api/v1/projects${p}`, { method, headers: { authorization: `Bearer ${session(ana)}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(json);
        let pr = await projects('POST', '', { name: 'Scope Demo' });
        assert.strictEqual(pr.status, 201, JSON.stringify(pr.body));
        const P = pr.body.id;
        const DEV_URI = 'https://dev.example.com/cb';
        pr = await projects('POST', `/${P}/apps`, { name: 'App A', environment: 'sandbox', type: 'public', redirect_uris: [DEV_URI] });
        assert.strictEqual(pr.status, 201, JSON.stringify(pr.body));
        const A = pr.body.id;
        pr = await projects('POST', `/${P}/apps`, { name: 'App B', environment: 'sandbox', type: 'public', redirect_uris: [DEV_URI] });
        const B = pr.body.id;
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        const devConfirm = (client, scope, consentAnswer) => post('/oauth/confirm', {
            token: session(ana), client_id: client, redirect_uri: DEV_URI, scope, state: 's', code_challenge: challenge, code_challenge_method: 'S256',
            ...(consentAnswer === undefined ? {} : { consent: consentAnswer }),
        });
        const devToken = async (client, code) => {
            const x = await form('/oauth/token', { grant_type: 'authorization_code', client_id: client, code, redirect_uri: DEV_URI, audience: 'openvibe.media', code_verifier: verifier });
            assert.strictEqual(x.status, 200, JSON.stringify(x.body));
            const v = serviceAuth.verifyServiceToken(x.body.access_token, { publicKey: keys.publicKey, issuer: ISSUER, audience: 'openvibe.media', acceptSandbox: true });
            assert.strictEqual(v.ok, true, v.reason);
            return { body: x.body, claims: v.claims };
        };
        r = await get(`/oauth/authorize?${new URLSearchParams({ client_id: A, redirect_uri: DEV_URI, response_type: 'code', scope: 'consent:face.looks', state: 'd', code_challenge: challenge, code_challenge_method: 'S256' })}`);
        assert.strictEqual(new URL(r.location).searchParams.get('error'), 'invalid_scope', 'a developer app is refused an unknown purpose too');
        r = await get(`/oauth/client-info?${new URLSearchParams({ client_id: A, redirect_uri: DEV_URI, code_challenge: challenge, code_challenge_method: 'S256', scope: 'consent:ai.train consent:app.data' })}`);
        assert.deepStrictEqual(r.body.purposes.map((p) => p.id), ['ai.train', 'app.data']);
        assert.deepStrictEqual(r.body.refused, [], 'consent scopes are not capabilities the screen refuses');
        // Ana grants App A ai.train (and refuses app.data).
        r = await devConfirm(A, 'consent:ai.train consent:app.data');
        assert.deepStrictEqual(r.body.consent.ask.map((p) => p.id), ['ai.train', 'app.data']);
        r = await devConfirm(A, 'consent:ai.train consent:app.data', { shown: ['ai.train', 'app.data'], allow: ['ai.train'], adult: true, text_version: TEXT });
        let dt = await devToken(A, codeOf(r));
        assert.deepStrictEqual(dt.claims.consent, ['ai.train'], 'the app token carries exactly the granted purpose');
        assert.deepStrictEqual(dt.claims.cap, [], 'a purpose is never a capability');
        assert.strictEqual(dt.claims.on_behalf_of, ana.subject_id);
        assert.strictEqual(dt.body.scope, 'consent:ai.train');
        assert.strictEqual(contracts.validate('identity.service-token-claims@1', dt.claims).valid, true, 'the claims still fit the token contract');
        // App B asks for the same purpose: it sees no grant, is asked fresh, and its token has none.
        r = await devConfirm(B, 'consent:ai.train');
        assert.deepStrictEqual(r.body.consent.ask.map((p) => p.id), ['ai.train'], 'App A\'s grant is not shown to App B');
        assert.deepStrictEqual(r.body.consent.granted, []);
        r = await devConfirm(B, 'consent:ai.train', { shown: ['ai.train'], allow: [], text_version: TEXT });
        dt = await devToken(B, codeOf(r));
        assert.deepStrictEqual(dt.claims.consent, [], 'App B\'s token carries nothing of App A\'s');
        assert.strictEqual(dt.body.scope, '');
        // B cannot narrow its way to A's grant at the token endpoint either.
        r = await devConfirm(B, 'consent:ai.train');
        assert.ok(r.body.redirect, 'B\'s refusal keeps it quiet');
        const widen = await form('/oauth/token', { grant_type: 'authorization_code', client_id: B, code: codeOf(r), redirect_uri: DEV_URI, audience: 'openvibe.media', code_verifier: verifier, scope: 'consent:face.recognize' });
        assert.strictEqual(widen.status, 400); assert.strictEqual(widen.body.error, 'invalid_scope', 'the exchange never widens the purposes');
        // A's refusal of app.data does not silence B; B's refusal of ai.train does not touch A.
        r = await devConfirm(A, 'consent:ai.train');
        assert.ok(r.body.redirect, 'A is not asked again for what it holds');
        dt = await devToken(A, codeOf(r));
        assert.deepStrictEqual(dt.claims.consent, ['ai.train']);
        // The service check: each app's grant answers for that app alone, never for OpenVibe or another app.
        const ask = async (client) => (await consent.check({ purpose: 'ai.train', ...(client ? { client } : {}), subjects: [ana.subject_id] })).allowed[ana.subject_id];
        assert.strictEqual(await ask(A), true);
        assert.strictEqual(await ask(B), false);
        assert.strictEqual(await ask(SITE1), false);
        assert.strictEqual(await ask(null), false, 'an app\'s grant is never OpenVibe\'s own');
        // The account page names both apps, A with its grant first.
        apps = await me('GET', '/apps');
        const names = apps.body.apps.map((a) => a.name);
        assert.ok(names.indexOf('App A') < names.indexOf('App B'), 'apps with a grant first');
        const appA = apps.body.apps.find((a) => a.client === A);
        assert.strictEqual(appA.third_party, true);
        assert.deepStrictEqual(appA.granted.map((g) => g.purpose), ['ai.train']);
        assert.deepStrictEqual(appA.quiet.map((q) => q.purpose), ['app.data']);
        let known = true;
        try { contracts.schema('network.me-consent-apps-result@1'); } catch { known = false; }
        if (known) assert.strictEqual(contracts.validate('network.me-consent-apps-result@1', apps.body).valid, true, 'the answer fits the contract');

        // ══ The record: export carries the refusals; deletion drops them ══
        const exported = await consentMod.exportOf(db, ana.subject_id);
        assert.ok(exported.refusals.length >= 3 && exported.refusals.every((x) => x.client && x.purpose && x.quiet_until), 'the export holds the refusals');
        await db.tx(async (tx) => { await consentMod.revokeForDeletion(tx, [ana.subject_id], { at: new Date().toISOString() }); });
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM consent_refusals WHERE subject = ?').get(ana.subject_id)).n, 0, 'deletion drops the refusals');
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM consents WHERE subject = ? AND revoked_at IS NULL').get(ana.subject_id)).n, 0, 'and revokes the grants');

        // ══ The migration is expand-only ══
        const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0044_consent_refusals.sql'), 'utf8');
        assert.match(sql, /^-- phase: expand$/m);
        assert.ok(!/\b(DROP|ALTER)\b/i.test(sql.replace(/^--.*$/gm, '')), 'expand only');
    } finally {
        server.close();
        console.log = log;
    }
    console.log('consent purpose scopes: ok');
    process.exit(0);
})().catch((e) => { console.log = log; console.error(e); process.exit(1); });

/** Run login.js's askPurposes against a small DOM and return what it built. */
function runAskPurposes(step) {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'login.js'), 'utf8');
    const start = js.indexOf('function askPurposes(step) {');
    assert.ok(start > 0, 'askPurposes exists');
    let depth = 0, end = start;
    for (let i = js.indexOf('{', start); i < js.length; i++) {
        if (js[i] === '{') depth++;
        else if (js[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    const source = js.slice(start, end);
    assert.ok(!/innerHTML/.test(source), 'built from DOM nodes only');
    class Node {
        constructor(tag) { this.tagName = tag; this.children = []; this.className = ''; this.hidden = false; this._text = ''; this.attrs = {}; }
        set textContent(v) { this._text = String(v); this.children = []; }
        get textContent() { return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
        append(...kids) { this.children.push(...kids); }
        replaceChildren(...kids) { this.children = [...kids]; this._text = ''; }
        focus() {}
        all(out = []) { for (const c of this.children) if (typeof c !== 'string') { out.push(c); c.all(out); } return out; }
        querySelectorAll(sel) {
            const cls = sel.replace(/:checked$/, '').replace(/^\./, '');
            return this.all().filter((n) => n.className.split(' ').includes(cls) && (!sel.endsWith(':checked') || n.checked));
        }
    }
    const nodes = {};
    for (const id of ['purposes-head', 'purposes-list', 'purposes-adult', 'purposes-adult-box', 'purposes-already', 'purposes-continue', 'purposes-form']) nodes[id] = new Node(id);
    const document = { getElementById: (id) => nodes[id] || null, createElement: (t) => new Node(t) };
    vm.runInNewContext(`${source}; askPurposes(step);`, {
        document, step, clientName: 'Site', setActivePanel: () => {}, showMsg: () => {}, Promise,
    });
    return {
        boxes: nodes['purposes-list'].all().filter((n) => n.tagName === 'input'),
        button: nodes['purposes-continue'],
        adultRow: nodes['purposes-adult'],
    };
}
})().catch((e) => { console.error(e); process.exit(1); });
