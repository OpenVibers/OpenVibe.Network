'use strict';
// The account ID: the person's own canonical subject id (usr_…).
//   - the account page (/my) shows it, in a chip, with the kit's Copy button
//   - GET /api/auth/me answers it for the signed-in person, and nobody else's
//   - llms.txt and llms-full.txt name the endpoint, so an agent finds it
//   node --import ./test/helpers/pg-preload.mjs test/account-id.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const vm = require('vm');
const express = require('express');
const { getDb } = require('../server/db/database');
const { signToken } = require('../server/auth/routes');
const authRoutes = require('../server/auth/routes');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'my.html'), 'utf8');
const profileJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'my', 'profile.js'), 'utf8');
const coreJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'my', 'core.js'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// ── The account page ─────────────────────────────────────────────────────────
assert.match(html, /id="account-id-card"/, 'the account page has an Account ID card');
assert.match(html, /Account ID<\/h3>/, 'the card is named Account ID');
assert.match(html, /apps and robots that ask for your OpenVibe account ID/, 'it says what the id is for');
assert.match(html, /data-ovk-copy="#account-id-value"/, "the kit's copy button copies the value");
assert.match(html, /<script src="\/shared\/kit-web\.js" defer><\/script>/, 'the kit (and its copy button) is on the page');
assert.match(html, /<pre tabindex="0" id="account-id-value">/, "the value sits in the kit's monospace snippet");
assert.ok(!/usr_[A-Z0-9]{8,}/.test(html), "the page hardcodes nobody's id: the signed-in person's own fills it");
assert.match(profileJs, /renderAccountId\(data\.user\)/, 'the page fills it from the signed-in person\'s own /api/auth/me');
assert.match(coreJs, /account-id-card[\s\S]{0,80}hidden = true/, 'an anonymous session shows no account id');

// ── The client: it shows the person its own id, and nobody else's ───────────
const start = profileJs.indexOf('function renderAccountId(user) {');
assert.ok(start > 0, 'renderAccountId exists');
let depth = 0, end = start;
for (let i = profileJs.indexOf('{', start); i < profileJs.length; i++) {
    if (profileJs[i] === '{') depth++;
    else if (profileJs[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const source = profileJs.slice(start, end);
function renderAccountId(user) {
    const value = { textContent: '' };
    const document = { getElementById: (id) => (id === 'account-id-value' ? value : null) };
    vm.runInNewContext(`${source}; renderAccountId(user);`, { document, user });
    return value.textContent;
}
assert.strictEqual(renderAccountId({ subject_id: 'usr_AAA111' }), 'usr_AAA111', 'the page shows the id it is given');
assert.strictEqual(renderAccountId({}), 'Not available yet.', 'no id, no invention');
assert.ok(!renderAccountId({ subject_id: 'usr_AAA111' }).includes('usr_BBB222'), 'never another id');

(async () => {
const db = getDb();
await db.prepare("INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (9101, 'acctalpha', 'alpha@example.test', 'x', 1)").run();
await db.prepare("INSERT INTO users (id, username, email, password_hash, email_verified) VALUES (9102, 'acctbeta', 'beta@example.test', 'x', 1)").run();
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = { jwt: { issuer: 'https://openvibe.network', accessTokenExpiry: '1h' } };
const alpha = await db.prepare('SELECT * FROM users WHERE id = 9101').get();
const beta = await db.prepare('SELECT * FROM users WHERE id = 9102').get();
const tokenA = signToken(alpha, keys.privateKey, config);
const tokenB = signToken(beta, keys.privateKey, config);

const app = express();
app.use(express.json());
Object.assign(app.locals, { db, config, privateKey: keys.privateKey, publicKey: keys.publicKey });
app.use('/api/auth', authRoutes);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const me = async (token) => {
    const res = await fetch(base + '/api/auth/me', { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.text() };
};

try {
    // ── The API: the caller's own account id, and nobody else's ──────────────
    const a = await me(tokenA);
    assert.strictEqual(a.status, 200, 'a signed-in person is answered');
    const userA = JSON.parse(a.body).user;
    assert.match(userA.subject_id, /^usr_/, 'the account id is a usr_ subject id');
    const b = await me(tokenB);
    const userB = JSON.parse(b.body).user;
    assert.match(userB.subject_id, /^usr_/, 'the other person has one too');
    assert.notStrictEqual(userA.subject_id, userB.subject_id, 'two people, two account ids');
    assert.ok(!a.body.includes(userB.subject_id), "the first person's answer never carries the other's id");
    assert.ok(!b.body.includes(userA.subject_id), "the other answer never carries the first's id");
    const guest = await me(null);
    assert.strictEqual(guest.status, 401, 'a guest gets no account id');

    // The page shows exactly what the API answered for that person.
    assert.strictEqual(renderAccountId(userA), userA.subject_id, 'the page shows the caller\'s own id');
    assert.ok(!renderAccountId(userA).includes(userB.subject_id), 'and nobody else\'s');

    // ── The docs: the endpoint is named, for people and for agents ───────────
    const home = require('../server/home/render');
    const llms = home.llmsTxt();
    assert.ok(llms.includes('/api/auth/me'), 'llms.txt names the endpoint an agent needs');
    assert.ok(llms.includes('subject_id'), 'llms.txt names the field');
    assert.match(llms, /## Your account ID/, 'llms.txt has an account ID section');
    const full = home.llmsFullTxt({ baseUrl: 'https://openvibe.network' });
    assert.ok(full.includes('/api/auth/me') && full.includes('subject_id'), 'llms-full.txt names it too');

    assert.ok(readme.includes('## Your account ID'), 'the API docs have an account ID entry');
    assert.ok(readme.includes('GET /api/auth/me') && readme.includes('user.subject_id'), 'the docs name the endpoint and the field');
    assert.ok(/curl -s https:\/\/openvibe\.network\/api\/auth\/me/.test(readme), 'the docs carry a curl example');
    assert.ok(readme.includes('openvibe-sdk/auth'), 'the docs say how to read it with the SDK');
} finally {
    server.close();
}
console.log('account id: all checks passed');
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
