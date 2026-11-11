'use strict';
// The login page's passkey button wears the page's own secondary-button look, and Continue Anonymously
// hides when the return address is a page that only makes sense signed in (the machines hub).
//   ov test test/login-passkey-anon.test.js   (or: node test/login-passkey-anon.test.js)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LOGIN = fs.readFileSync(path.join(__dirname, '..', 'public/js/login.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public/login.html'), 'utf8');

function block(from, fnName) {
    const start = LOGIN.indexOf(from);
    const fnStart = LOGIN.indexOf(`function ${fnName}(`, start);
    assert.ok(start >= 0 && fnStart > start, `${fnName} exists`);
    let depth = 0;
    for (let i = LOGIN.indexOf('{', fnStart); i < LOGIN.length; i++) {
        if (LOGIN[i] === '{') depth++;
        else if (LOGIN[i] === '}' && --depth === 0) return LOGIN.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${fnName}`);
}

// The passkey button: the page's secondary look, addressable, and no kit classes the page never loads.
const at = LOGIN.indexOf('Sign in with a passkey');
assert.ok(at >= 0, 'the passkey button exists');
const passkeyBlock = LOGIN.slice(Math.max(0, at - 600), at + 100);
assert.match(passkeyBlock, /button\.className = '[^']*\banon-btn\b[^']*'/, 'the passkey button wears anon-btn');
assert.ok(!/ovk-btn/.test(passkeyBlock), 'no kit classes the login page never loads');
assert.match(passkeyBlock, /button\.id = 'passkey-btn'/, 'the passkey button has an id');
assert.ok(HTML.includes('id="anon-btn"'), 'Continue Anonymously has an id');

// The signed-in-only rule, run for real.
const sandbox = { URL };
vm.createContext(sandbox);
const src = block('// Pages that only make sense signed in', 'isSignedInOnlyReturn');
const isSignedInOnlyReturn = vm.runInContext(`${src}\nisSignedInOnlyReturn;`, sandbox);
for (const yes of ['https://openvibe.link/machines', 'https://openvibe.link/machines#pair', 'https://openvibe.link/machines?pair=1', '/machines', '/machines?pair=1', '/machines#pair']) {
    assert.strictEqual(isSignedInOnlyReturn(yes), true, `signed-in-only: ${yes}`);
}
for (const no of ['', '/', '/login', 'https://openvibe.link/', 'https://openvibe.link/pair', 'https://openvibe.my/', 'https://evil.example/machines', '//evil.example/machines', 'javascript:alert(1)']) {
    assert.strictEqual(isSignedInOnlyReturn(no), false, `not signed-in-only: ${no}`);
}

// init hides the button and its divider on a machines return.
assert.match(LOGIN, /isSignedInOnlyReturn\(params\.get\('return'\)\)/, 'init consults the rule');
assert.match(LOGIN, /getElementById\('anon-btn'\)/, 'init hides Continue Anonymously');

console.log('login-passkey-anon.test.js: all assertions passed');
