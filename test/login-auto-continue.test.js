'use strict';
// When /login continues by itself (public/js/login.js maybeContinue). An app's sign-in shows the chooser, the way
// Google's does (the owner, 2026-10-26: signing out and back in "immediately logs you in and doesn't allow you to
// choose"); seamless sign-in across sites is the sites' silent one (prompt=none, answered by /oauth/authorize without
// this page). It continues only for the account chosen a moment ago in this tab (a site menu's switch or "add another
// account" sets ov_continue_as before going back through the site's sign-in) or the one the site names (login_hint).
// Never for a third-party app, never when the site asks for the chooser, never as an anonymous account. The page's
// init sends switch_to / add_account / prompt=login to the right panel, and /oauth/authorize passes prompt and
// login_hint on. Runs the page's own functions with stand-ins.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'login.js'), 'utf8');
function block(from, fnName) {
    const start = js.indexOf(from);
    const fnStart = js.indexOf(`function ${fnName}(`, start);
    assert.ok(start >= 0 && fnStart > start, `${fnName} exists`);
    let depth = 0;
    for (let i = js.indexOf('{', fnStart); i < js.length; i++) {
        if (js[i] === '{') depth++;
        else if (js[i] === '}' && --depth === 0) return js.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${fnName}`);
}
const source = block("const CONTINUE_KEY = 'ov_continue_as';", 'maybeContinue');
assert.match(js, /renderConsent\(info\);\n\s*maybeContinue\(info\);/, 'it runs once the Network names the app');

const me = { id: 7, username: 'goosely', display_name: 'goosely', token: 't' };
const alt = { id: 8, username: 'Alt', display_name: 'Alt', token: 'u' };
function run({ info = { name: 'OpenVibe.Video', third_party: false }, accounts = [me], query = 'client_id=media-hub&redirect_uri=x', chosen = null, age = 0 } = {}) {
    const picked = [];
    const subtitle = { textContent: '' };
    const params = new URLSearchParams(query);
    const session = {};
    if (chosen != null) session.ov_continue_as = JSON.stringify({ id: String(chosen), at: Date.now() - age });
    vm.runInNewContext(`${source}; maybeContinue(info); maybeContinue(info); this.left = sessionStorage.getItem('ov_continue_as');`, {
        info, params, isOAuth: params.has('client_id') && params.has('redirect_uri'), Date, JSON, String, Number,
        getSavedAccounts: () => accounts, selectAccount: (a) => picked.push(a.id),
        sessionStorage: { getItem: (k) => (k in session ? session[k] : null), setItem: (k, v) => { session[k] = String(v); }, removeItem: (k) => { delete session[k]; } },
        document: { getElementById: (id) => (id === 'chooser-subtitle' ? subtitle : null) },
    });
    return { picked, subtitle: subtitle.textContent, left: session.ov_continue_as || null };
}

// The bug: one saved account, signed out of the site, Sign in again: the chooser, not straight back in.
assert.deepStrictEqual(run().picked, [], 'an app sign-in shows the chooser, even with one saved account');
assert.deepStrictEqual(run({ accounts: [me, alt] }).picked, []);

// Chosen a moment ago in this tab (a site menu): continues once, as it, and the mark is used up.
let r = run({ accounts: [me, alt], chosen: 8 });
assert.deepStrictEqual(r.picked, [8], 'the account just chosen');
assert.strictEqual(r.subtitle, 'Continuing to OpenVibe.Video as Alt…');
assert.strictEqual(r.left, null, 'used once');
assert.deepStrictEqual(run({ chosen: 7, age: 3 * 60 * 1000 }).picked, [], 'a choice from minutes ago is not a choice now');
assert.deepStrictEqual(run({ chosen: 99 }).picked, [], 'an account not saved here');
assert.strictEqual(run({ chosen: 7, query: 'client_id=a&redirect_uri=x&prompt=select_account' }).left, null, 'asked for the chooser: the mark is dropped too');

// The site names the account (OpenID Connect login_hint): a username (any case, @ allowed) or an id.
assert.deepStrictEqual(run({ accounts: [me, alt], query: 'client_id=a&redirect_uri=x&login_hint=alt' }).picked, [8]);
assert.deepStrictEqual(run({ accounts: [me, alt], query: 'client_id=a&redirect_uri=x&login_hint=%40goosely' }).picked, [7]);
assert.deepStrictEqual(run({ query: 'client_id=a&redirect_uri=x&login_hint=someoneelse' }).picked, [], 'not saved here: the chooser');

// Never by itself:
assert.deepStrictEqual(run({ info: { name: 'ClipTool', third_party: true }, chosen: 7 }).picked, [], 'a third-party app: the person chooses (and sees its consent)');
assert.deepStrictEqual(run({ chosen: 7, query: 'client_id=a&redirect_uri=x&prompt=select_account' }).picked, [], 'asked for the chooser');
assert.deepStrictEqual(run({ chosen: 7, query: 'client_id=a&redirect_uri=x&prompt=login' }).picked, []);
assert.deepStrictEqual(run({ accounts: [{ ...me, is_anon: true }], chosen: 7 }).picked, [], 'an anonymous account is never assumed');
assert.deepStrictEqual(run({ chosen: 7, query: 'return=/my' }).picked, [], 'not an app sign-in');

// Every way off this page to a site remembers the account, so that site's sign-in continues as it.
const select = block('async function selectAccount(account)', 'selectAccount');
assert.match(select, /\} else \{[\s\S]*rememberChoice\(account\.id\);[\s\S]*goBack\(/, 'switching (not an app) remembers the account and goes back');
const login = block('async function handleLogin(e)', 'handleLogin');
assert.match(login, /rememberChoice\(data\.user\.id\);\s*\n[^\n]*\n\s*goBack\(800\);/, 'a new sign-in (add another account) too');

// The page's init: switch_to switches (or asks for that account's password), add_account and prompt=login show the form.
const init = js.slice(js.indexOf('(function init() {'));
assert.match(init, /const switchTo = params\.get\('switch_to'\);\s*\n\s*if \(switchTo && !isOAuth\) \{[\s\S]*selectAccount\(account\);[\s\S]*prefillUsername\(params\.get\('login_hint'\)\);/);
assert.match(init, /params\.get\('add_account'\) === '1' \|\| params\.get\('prompt'\) === 'login'\) \{\s*\n\s*showAuthForm\('login'\);/);

// Where the page may go back to: the owned zones, or any first-party origin the Network names (manifests).
const ret = block('let returnOrigins = new Set();', 'getReturnUrl');
const safe = block('const OV_OWNED_ZONES', 'safeReturnUrl');
function back(raw, origins = []) {
    const ctx = { params: new URLSearchParams({ return: raw }), URL, window: { location: { origin: 'https://openvibe.network', hostname: 'openvibe.network' } }, fetch: () => new Promise(() => {}), API_BASE: 'https://openvibe.network' };
    vm.runInNewContext(`${safe}\n${ret.replace('let returnOrigins = new Set();', 'var returnOrigins = new Set();')}\nreturnOrigins = new Set(${JSON.stringify(origins)});\nthis.out = getReturnUrl();`, ctx);
    return ctx.out;
}
assert.strictEqual(back('https://openvibe.live/api/auth/sso/login?next=%2F'), 'https://openvibe.live/api/auth/sso/login?next=%2F');
assert.strictEqual(back('https://openvibe.video/auth/login?next=x'), '/', 'not an owned zone, the list not read yet: home');
assert.strictEqual(back('https://openvibe.video/auth/login?next=x', ['https://openvibe.video']), 'https://openvibe.video/auth/login?next=x', 'a manifest origin');
assert.strictEqual(back('https://evil.example/x', ['https://openvibe.video']), '/');
assert.strictEqual(back('http://openvibe.video/x', ['https://openvibe.video']), '/', 'https only');
assert.strictEqual(back('https://user:pw@openvibe.video/x', ['https://openvibe.video']), '/');
assert.strictEqual(back('https://openvibe.video/x\\@evil.example', ['https://openvibe.video']), '/', 'backslashes go home');

// /oauth/authorize passes the prompt and a clean login_hint on.
const routes = fs.readFileSync(path.join(__dirname, '..', 'server', 'auth', 'oauth-routes.js'), 'utf8');
assert.match(routes, /\['select_account', 'login'\]\.includes\(String\(req\.query\.prompt \|\| ''\)\)\) loginParams\.set\('prompt'/, '/oauth/authorize passes the prompt to the page');
const { cleanLoginHint } = require('../server/auth/oauth-routes');
assert.strictEqual(cleanLoginHint('@goosely'), '@goosely');
assert.strictEqual(cleanLoginHint('42'), '42');
assert.strictEqual(cleanLoginHint('a b'), '');
assert.strictEqual(cleanLoginHint('<script>'), '');
assert.strictEqual(cleanLoginHint('x'.repeat(65)), '');
assert.deepStrictEqual(require('../server/auth/oidc').metadata({ jwt: { issuer: 'https://openvibe.network' }, baseUrl: 'https://openvibe.network' }).prompt_values_supported, ['none', 'login', 'select_account']);

console.log('login auto-continue: all checks passed');
