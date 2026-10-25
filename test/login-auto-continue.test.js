'use strict';
// Straight through on /login (public/js/login.js maybeContinue): a first-party site's sign-in with one account saved in
// this browser continues as it with nothing to click; a third-party app, several accounts, another active account, an
// anonymous one, or a site asking for the chooser (prompt=select_account | login) still shows it. And /oauth/authorize
// passes that prompt on to the page. Runs the function itself with stand-ins for the page.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'login.js'), 'utf8');
const start = js.indexOf('let autoContinued = false;');
const fnStart = js.indexOf('function maybeContinue(info) {', start);
assert.ok(start > 0 && fnStart > start, 'maybeContinue exists');
let depth = 0, end = fnStart;
for (let i = js.indexOf('{', fnStart); i < js.length; i++) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const source = js.slice(start, end);
assert.match(js, /renderConsent\(info\);\n\s*maybeContinue\(info\);/, 'it runs once the Network names the app');

const me = { id: 7, username: 'goosely', display_name: 'goosely', token: 't' };
function run({ info = { name: 'OpenVibe.Agents', third_party: false }, accounts = [me], active = '7', query = 'client_id=actor&redirect_uri=x' } = {}) {
    const picked = [];
    const subtitle = { textContent: '' };
    const params = new URLSearchParams(query);
    vm.runInNewContext(`${source}; maybeContinue(info); maybeContinue(info);`, {
        info, params, isOAuth: params.has('client_id') && params.has('redirect_uri'),
        getSavedAccounts: () => accounts, selectAccount: (a) => picked.push(a.id),
        localStorage: { getItem: (k) => (k === 'openvibe_active_account' ? active : null) },
        document: { getElementById: (id) => (id === 'chooser-subtitle' ? subtitle : null) },
    });
    return { picked, subtitle: subtitle.textContent };
}

let r = run();
assert.deepStrictEqual(r.picked, [7], 'one saved account, a first-party site: continues once, as it');
assert.strictEqual(r.subtitle, 'Continuing to OpenVibe.Agents as goosely…');
assert.deepStrictEqual(run({ active: null }).picked, [7], 'no active account recorded: the only one');
assert.deepStrictEqual(run({ info: { name: 'ClipTool', third_party: true } }).picked, [], 'a third-party app: the person chooses (and sees its consent)');
assert.deepStrictEqual(run({ accounts: [me, { id: 8, username: 'alt', token: 'u' }] }).picked, [], 'several accounts: the chooser');
assert.deepStrictEqual(run({ active: '9' }).picked, [], 'another account is the active one: the chooser');
assert.deepStrictEqual(run({ accounts: [{ ...me, is_anon: true }] }).picked, [], 'an anonymous account is never assumed');
assert.deepStrictEqual(run({ query: 'client_id=actor&redirect_uri=x&prompt=select_account' }).picked, [], 'asked for the chooser');
assert.deepStrictEqual(run({ query: 'client_id=actor&redirect_uri=x&prompt=login' }).picked, []);
assert.deepStrictEqual(run({ query: 'next=/my' }).picked, [], 'not an app sign-in');

const routes = fs.readFileSync(path.join(__dirname, '..', 'server', 'auth', 'oauth-routes.js'), 'utf8');
assert.match(routes, /\['select_account', 'login'\]\.includes\(String\(req\.query\.prompt \|\| ''\)\)\) loginParams\.set\('prompt'/, '/oauth/authorize passes the prompt to the page');

console.log('login auto-continue: all checks passed');
