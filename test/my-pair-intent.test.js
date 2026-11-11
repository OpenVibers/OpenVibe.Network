'use strict';
// Pairing intent on the hub: openvibe.link/machines#pair (and /pair, which lands on ?pair=1 so the
// intent survives a sign-in round trip) opens Machines and starts pairing at once.
//   ov test test/my-pair-intent.test.js   (or: node test/my-pair-intent.test.js)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'public/js/my/core.js'), 'utf8');
function block(from, fnName) {
    const start = CORE.indexOf(from);
    const fnStart = CORE.indexOf(`function ${fnName}(`, start);
    assert.ok(start >= 0 && fnStart > start, `${fnName} exists`);
    let depth = 0;
    for (let i = CORE.indexOf('{', fnStart); i < CORE.length; i++) {
        if (CORE[i] === '{') depth++;
        else if (CORE[i] === '}' && --depth === 0) return CORE.slice(fnStart, i + 1);
    }
    throw new Error(`unbalanced ${fnName}`);
}
const src = block('function showSection(', 'openInitialSection');
assert.match(src, /mcPair\(\)/, 'pairing intent starts pairing');

function runSection({ pathname = '/machines', hash = '', search = '', anon = false }) {
    const shown = [], paired = [];
    const sandbox = {
        window: { location: { pathname, hash, search } },
        document: { getElementById: (id) => (id === 'sec-machines' || id === 'sec-anon' ? {} : null) },
        isAnonSession: () => anon,
        showSection: (id) => shown.push(id),
        mcPair: () => paired.push(true),
        handleVerifyEmailToken: () => {},
        setTimeout: () => {},
        URLSearchParams,
    };
    vm.createContext(sandbox);
    vm.runInContext(`${src}\nopenInitialSection();`, sandbox);
    return { shown, paired };
}

// #pair opens Machines and starts pairing for an account session.
let r = runSection({ hash: '#pair' });
assert.deepStrictEqual(r.shown, ['machines'], '#pair opens Machines');
assert.strictEqual(r.paired.length, 1, '#pair starts pairing');

// ?pair=1 does the same after a sign-in round trip ate the fragment.
r = runSection({ search: '?pair=1' });
assert.deepStrictEqual(r.shown, ['machines'], '?pair=1 opens Machines');
assert.strictEqual(r.paired.length, 1, '?pair=1 starts pairing');

// Anonymous mode never pairs: the anon section shows instead.
r = runSection({ hash: '#pair', anon: true });
assert.deepStrictEqual(r.shown, ['anon'], 'anon keeps the anon section');
assert.strictEqual(r.paired.length, 0, 'anon never starts pairing');

// Anywhere else the intent is ignored, and a plain visit pairs nothing.
r = runSection({ hash: '#pair', pathname: '/profile' });
assert.deepStrictEqual(r.shown, ['machines'], 'pair intent lands on Machines from any path');
assert.strictEqual(runSection({}).paired.length, 0, 'no intent starts nothing');

console.log('my-pair-intent.test.js: all assertions passed');
