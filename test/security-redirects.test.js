'use strict';
// Post-sign-in navigation targets: /login?return=… and /sso/fanout?next=… must never run
// javascript: URLs or leave for a host OpenVibe does not own.
//   node test/security-redirects.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { OWNED_ZONES } = require('../server/auth/sso-owned');
const { safeNext } = require('../server/auth/sso-targets');

/** The page's navigation guard, evaluated as the browser would at `pageOrigin`. */
function pageGuard(file, name, pageOrigin) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    const m = html.match(/\/\/ safe-redirect:begin\n([\s\S]*?)\/\/ safe-redirect:end/);
    assert.ok(m, `${file} has a safe-redirect block`);
    const loc = new URL(pageOrigin);
    // eslint-disable-next-line no-new-func
    return new Function('window', 'location', `${m[1]}\nreturn { fn: ${name}, zones: OV_OWNED_ZONES };`)({ location: loc }, loc);
}

const BAD = [
    'javascript:alert(document.cookie)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)',
    '//evil.example', '/\\evil.example', '/\t/evil.example', '\\\\evil.example',
    'https://evil.example/', 'https://openvibe.network.evil.example/', 'https://evilopenvibe.network/',
    'https://openvibe.lol/', 'https://login.openvibe.xyz/', 'http://openvibe.live/', 'https://user:pw@evil.example/',
];
const GOOD = [
    ['/', '/'], ['/my#linked', '/my#linked'], ['/admin?tab=users', '/admin?tab=users'],
    ['https://openvibe.live/@x?y=1', 'https://openvibe.live/@x?y=1'],
    ['https://json.openvibe.tools/', 'https://json.openvibe.tools/'],
    ['https://openvibe.network/admin', 'https://openvibe.network/admin'],
    ['https://ingest.openre.stream/', 'https://ingest.openre.stream/'],
];

for (const [file, name] of [['login.html', 'safeReturnUrl'], ['sso-fanout.html', 'safeNext']]) {
    const { fn, zones } = pageGuard(file, name, 'https://openvibe.network');
    assert.deepStrictEqual([...zones].sort(), [...OWNED_ZONES].sort(), `${file}: owned zones match server/auth/sso-owned.js`);
    for (const b of BAD) assert.strictEqual(fn(b), '/', `${file}: ${JSON.stringify(b)} is refused`);
    for (const [g, want] of GOOD) assert.strictEqual(fn(g), want, `${file}: ${g} is kept`);
    assert.strictEqual(fn(''), '/');
    assert.strictEqual(fn(null), '/');
    // local development: the page's own origin is fine, other local ports are not an open door in production
    const local = pageGuard(file, name, 'http://localhost:4000').fn;
    assert.strictEqual(local('http://localhost:4000/my'), 'http://localhost:4000/my');
    assert.strictEqual(local('http://localhost:3000/'), 'http://localhost:3000/', 'local dev hops between local ports');
    assert.strictEqual(fn('http://localhost:3000/'), '/', 'but never from a production page');
}

// the server-side twin (server/auth/sso-targets.js)
for (const b of BAD) assert.strictEqual(safeNext(b, { NODE_ENV: 'production' }), '/', `safeNext ${JSON.stringify(b)} is refused`);
for (const [g, want] of GOOD) assert.strictEqual(safeNext(g, { NODE_ENV: 'production' }), want, `safeNext ${g} is kept`);

console.log('post-sign-in redirects: all checks passed');
