'use strict';
// The account-deletion loop (moosely, 2026-11-06):
//   - "Sign in again" must be a real re-authentication. The new /login?reauth=1 path always shows the password
//     form (a saved session is not handed back), the new token carries auth_time = now, and the person comes back
//     to /my#delete with the username field ready and the 10-minute window stated.
//   - The old path (add_account=1) is what reused the session; these checks fail if the delete step goes back to it.
//   - While a deletion is scheduled, every page shows the banner with one "Keep my account" button, and the
//     sign-in page offers the same choice first.
//   node test/account-deletion-reauth.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { parseHTML } = require('linkedom');
const { getDb } = require('../server/db/database');
const subjects = require('../server/identity/subjects');
const accountMerge = require('../server/identity/account-merge');
const accountData = require('../server/identity/account-data');
const authRoutes = require('../server/auth/routes');
const { makeRequireAuth } = require('../server/auth/session');
const staffClaims = require('../server/auth/staff-claims').staffClaims;
const { reauthUrl } = require('../server/auth/reauth');
const { signInUrl } = require('../server/admin/ai-config-proxy');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── The browser helpers: one re-authentication URL, and the banner ───────────
const safety = read('public/js/account-safety.js');
function safetyWindow() {
    const { window: win } = parseHTML('<!doctype html><html><body></body></html>');
    const store = new Map();
    const calls = [];
    const root = {
        document: win.document,
        location: { origin: 'https://openvibe.network' },
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
        },
        fetch: async (url, opts = {}) => {
            calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {} });
            if ((opts.method || 'GET') === 'DELETE') {
                return { ok: true, status: 200, json: async () => ({ status: 'cancelled', deletion_id: 'del_x' }) };
            }
            return { ok: true, status: 200, json: async () => ({ deletion: { delete_after: new Date(Date.now() + 30 * 86400000).toISOString() } }) };
        },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
        dispatchEvent: () => {},
    };
    const context = {
        window: root, document: root.document, localStorage: root.localStorage, fetch: root.fetch,
        URLSearchParams, Date, JSON, Number, String, Object, setTimeout, clearTimeout, console,
    };
    vm.runInNewContext(safety, context);
    return { root, calls, api: root.OpenVibeDeletion, reauth: root.OpenVibeReauth };
}

const bannerTest = (async () => {
    const { root, calls, api, reauth } = safetyWindow();
    assert.strictEqual(reauth.url('/my#delete'), '/login?reauth=1&return=%2Fmy%23delete', 'the deletion return target');
    assert.strictEqual(reauth.url('/my#accounts', { account: '' }), '/login?reauth=1&login_hint=&return=%2Fmy%23accounts', 'merge leaves the username blank');
    assert.strictEqual(reauth.url('/admin#ai', { account: 'goosely' }), '/login?reauth=1&login_hint=goosely&return=%2Fadmin%23ai');
    assert.match(api.bannerText('2030-01-02T03:04:00.000Z'), /^Your account will be deleted on .+\.$/);
    assert.strictEqual(api.sessionToken(), null, 'signed out: no banner');

    // A saved account (the normal case) is found from localStorage.
    root.localStorage.setItem('openvibe_accounts', JSON.stringify([{ id: 7, username: 'Me', token: 'tok-saved' }]));
    root.localStorage.setItem('openvibe_active_account', '7');
    assert.strictEqual(api.sessionToken(), 'tok-saved');
    root.localStorage.setItem('openvibe_active_account', 'anon');
    assert.strictEqual(api.sessionToken(), null, 'an anonymous session has no account to delete');

    // The banner itself: the get, the exact sentence, the one Keep button, the DELETE.
    root.localStorage.setItem('openvibe_active_account', '7');
    const shown = await api.refreshBanner();
    assert.ok(shown && shown.delete_after, 'the banner came from GET /api/v1/account/deletion');
    const banner = root.document.getElementById('ov-deletion-banner');
    assert.ok(banner, 'the banner is on the page');
    assert.match(banner.textContent, /Your account will be deleted on /);
    const keep = root.document.getElementById('ov-deletion-keep');
    assert.strictEqual(keep.textContent, 'Keep my account');
    assert.strictEqual(banner.querySelectorAll('button').length, 1, 'exactly one button, which cancels it');
    keep.click();
    await new Promise((r) => setTimeout(r, 20));
    const del = calls.find((c) => c.method === 'DELETE');
    assert.ok(del, 'Keep my account calls DELETE /api/v1/account/deletion');
    assert.strictEqual(del.url, 'https://openvibe.network/api/v1/account/deletion');
    assert.strictEqual(del.headers.Authorization, 'Bearer tok-saved');
    assert.match(root.document.getElementById('ov-deletion-banner').textContent, /Kept\. Your account stays\./);
    api.removeBanner();
    assert.strictEqual(root.document.getElementById('ov-deletion-banner'), null);
})();

// ── The delete step uses the re-authentication path, never add_account ──────
const profile = read('public/js/my/profile.js');
assert.match(profile, /function reauthForDeletion\(\)[\s\S]*?\/login\?reauth=1&return=/, 'the Sign in again target asks for a real re-authentication');
assert.match(profile, /again\.onclick = reauthForDeletion/, 'the 401 prompt signs in again through reauth');
assert.doesNotMatch(profile, /again\.onclick = addAccount/, 'the old add_account path is gone: it reuses the session and the loop comes back');
assert.match(profile, /Your account stays usable for 30 days after you ask, and you can keep it at any time before then/, 'the step says the account stays usable and can be kept');
assert.match(profile, /A fresh sign-in gives you 10 minutes to confirm/, 'the step states the 10-minute window');
assert.match(profile, /window\.OpenVibeReauth\.go\('\/my#delete'\)/, 'a reauth return to the delete step');
assert.match(profile, /OpenVibeDeletion\.showBanner\(s\.body\)/, 'the banner appears as soon as the deletion is scheduled');
assert.match(profile, /hash === 'delete'|OV_DELETE_DEEP_LINK/, 'the return target is understood');
assert.match(profile, /ov:deletion-cancelled/, 'the banner can refresh this card');
assert.match(read('public/js/my/core.js'), /hash === 'delete' \? 'accounts' : hash/, 'core.js maps the #delete return target to the accounts section');
// The banner reads GET /deletion on every page; that read must not spend the 20-a-minute write budget.
const index = read('server/index.js');
assert.match(index, /skip: \(req\) => req\.method === 'GET' && req\.path === '\/deletion'/, 'GET /deletion is not rate-limited with the writes it feeds');
assert.match(index, /skip: \(req\) => !String\(req\.path\)\.startsWith\('\/merge'\)/, 'the merge limiter does not count the account data routes');

// ── /login?reauth=1 always asks for the password ────────────────────────────
const login = read('public/js/login.js');
function block(from, name) {
    const start = login.indexOf(from);
    const fnStart = login.indexOf(`function ${name}(`, start);
    assert.ok(start >= 0 && fnStart > start, `${name} exists`);
    let depth = 0;
    for (let i = login.indexOf('{', fnStart); i < login.length; i++) {
        if (login[i] === '{') depth++;
        else if (login[i] === '}' && --depth === 0) return login.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}
function reauthUser(query, accounts, active) {
    const params = new URLSearchParams(query);
    const context = {
        params, accounts, String,
        localStorage: { getItem: (k) => (k === 'openvibe_active_account' ? active : null) },
    };
    vm.runInNewContext(`${block("const isReauth = params.get('reauth') === '1';", 'reauthUsername')}; this.out = reauthUsername(accounts);`, context);
    return context.out;
}
assert.strictEqual(reauthUser('reauth=1', [{ id: 7, username: 'Me' }], '7'), 'Me', 'the active account is filled in');
assert.strictEqual(reauthUser('reauth=1&login_hint=%40Alt', [{ id: 7, username: 'Me' }], '7'), 'Alt', 'login_hint wins (merge uses another account)');
assert.strictEqual(reauthUser('reauth=1&login_hint=', [{ id: 7, username: 'Me' }], '7'), '', 'an empty login_hint leaves the merge username blank');
assert.strictEqual(reauthUser('reauth=1', [{ id: 8, username: 'First' }], null), 'First', 'no active account: the first saved one');
assert.match(login, /const isReauth = params\.get\('reauth'\) === '1'/, 'the page knows reauth mode');
const init = login.slice(login.indexOf('(function init() {'));
assert.match(init, /if \(isReauth\) \{\s*\n\s*showAuthForm\('login'\);[\s\S]*?return;\s*\n\s*\}/, 'reauth shows the password form, never the chooser');
assert.ok(init.indexOf('if (isReauth)') < init.indexOf('if (hasAccounts)'), 'the reauth form is chosen before the saved-account chooser');
assert.match(init, /if \(isReauth\)[\s\S]*?back\.style\.display = 'none'/, 'no "back to saved accounts" shortcut in reauth');
assert.match(login, /guardScheduledDeletion\(data\.token, \(\) => finishSignIn\(data\)\)/, 'a password sign-in checks a scheduled deletion first');
assert.match(login, /guardScheduledDeletion\(validToken, \(\) => continueAsAccount/, 'a saved-account sign-in checks it too');
assert.match(login, /OpenVibeDeletion\.cancelDeletion\(token\)/, 'Keep my account cancels the scheduled deletion there');
assert.match(login, /panel-keep/, 'the sign-in page shows the same choice before continuing');

// ── Every user-facing page loads the banner and the helper ──────────────────
const pages = [
    'public/index.html', 'public/my.html', 'public/wallet.html', 'public/pay.html', 'public/admin.html',
    'public/verify-email.html', 'public/login.html',
    'server/sites/page.js', 'server/bot/page.js', 'server/stats/open.js', 'server/status/routes.js',
    'server/profile/public.js', 'server/not-found.js', 'server/updates/routes.js',
];
for (const p of pages) assert.ok(read(p).includes('/js/account-safety.js'), `${p} loads the banner and reauth helper`);
assert.match(read('public/login.html'), /id="keep-account-btn"/);
assert.match(read('public/login.html'), /id="reauth-note"/);
assert.match(read('public/my.html'), /id="delete-card"/);
assert.match(read('public/my.html'), /stays usable for 30 days/);

// ── Server: a stale token is refused, a real re-login is fresh, the banner GET answers, DELETE keeps ─────
const serverTest = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-delete-reauth-'));
    const db = getDb();
    await accountMerge.ensureSchema(db);
    await accountData.ensureSchema(db);

    const ISSUER = 'https://openvibe.network';
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const config = { jwt: { issuer: ISSUER, accessTokenExpiry: '1h' }, baseUrl: ISSUER, loginUrl: ISSUER };
    process.env.OWNER_USERNAME = 'boss';

    const hash = bcrypt.hashSync('secret12', 4);
    const id = (await db.prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?) RETURNING id')
        .run('looped', 'looped@example.com', hash, 'user')).lastInsertRowid;
    await subjects.ensureUserSubject(db, await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);

    const requireAuth = makeRequireAuth(() => ({ db, publicKey: keys.publicKey, config }), authRoutes.signToken);
    const app = express();
    Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use('/api/v1/account', accountData.routers({
        requireAuth, staffClaims, dir, notify: () => {},
        contributeGuard: (_req, _res, next) => next(), confirmGuard: (_req, _res, next) => next(),
    }).me);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, token, body) => fetch(base + p, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

    try {
        const first = await call('POST', '/api/auth/login', null, { username: 'looped', password: 'secret12' });
        assert.strictEqual(first.status, 200, 'the person signs in');
        const firstClaims = jwt.decode(first.body.token);
        assert.ok(Math.abs(firstClaims.auth_time - Math.floor(Date.now() / 1000)) < 10, 'a sign-in carries auth_time = now');

        // The old path: the session is already signed in (auth_time 11 minutes ago). It is not fresh.
        const stale = jwt.sign({ sub: user.id, id: user.id, subject_id: user.subject_id, username: user.username, role: 'user',
            auth_time: Math.floor(Date.now() / 1000) - 11 * 60, iat: Math.floor(Date.now() / 1000) }, keys.privateKey,
        { algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' });
        const denied = await call('POST', '/api/v1/account/deletion', stale, { confirm_username: 'looped' });
        assert.strictEqual(denied.status, 401, 'an already-signed-in session is refused');
        assert.strictEqual(denied.body.error, 'deletion.sign_in_again');

        // A real re-authentication: POST /api/auth/login is what /login?reauth=1 does. The new token is fresh.
        const again = await call('POST', '/api/auth/login', null, { username: 'looped', password: 'secret12' });
        assert.strictEqual(again.status, 200, 'reauth signs in again');
        assert.notStrictEqual(again.body.token, first.body.token, 'a new token, not the session handed back');
        const freshClaims = jwt.decode(again.body.token);
        assert.ok(Math.abs(freshClaims.auth_time - Math.floor(Date.now() / 1000)) < 10, 'the reauthenticated token is fresh');

        const wrong = await call('POST', '/api/v1/account/deletion', again.body.token, { confirm_username: 'not-me' });
        assert.strictEqual(wrong.status, 400, 'the username is still typed exactly');

        const scheduled = await call('POST', '/api/v1/account/deletion', again.body.token, { confirm_username: 'looped' });
        assert.strictEqual(scheduled.status, 201, 'the fresh re-authentication schedules the deletion');
        assert.strictEqual(scheduled.body.status, 'scheduled');
        assert.ok(Date.parse(scheduled.body.delete_after) > Date.now() + 29 * 86400000, 'it is 30 days ahead');

        const status = await call('GET', '/api/v1/account/deletion', again.body.token);
        assert.strictEqual(status.status, 200);
        assert.strictEqual(status.body.deletion.deletion_id, scheduled.body.deletion_id, 'the banner GET sees it on every page');

        const kept = await call('DELETE', '/api/v1/account/deletion', again.body.token);
        assert.strictEqual(kept.status, 200, 'Keep my account cancels it');
        assert.strictEqual(kept.body.status, 'cancelled');
        const after = await call('GET', '/api/v1/account/deletion', again.body.token);
        assert.strictEqual(after.body.deletion, null, 'nothing is left scheduled (nothing ever needed cancelling for moosely)');
    } finally {
        await new Promise((r) => server.close(r));
    }
};

// ── The server helper: AI's fresh-required link is the same re-auth path ────
assert.strictEqual(reauthUrl('https://openvibe.network', '/my#delete'), 'https://openvibe.network/login?reauth=1&return=%2Fmy%23delete');
assert.strictEqual(signInUrl({ loginUrl: 'https://openvibe.network', baseUrl: 'https://openvibe.network' }),
    'https://openvibe.network/login?reauth=1&return=https%3A%2F%2Fopenvibe.network%2Fadmin%23ai');

Promise.all([bannerTest, serverTest()]).then(() => console.log('account deletion reauth: all checks passed')).catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
