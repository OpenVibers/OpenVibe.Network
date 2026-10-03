'use strict';
// Shown-once responses, logs and persisted events keep secrets private.
const assert = require('assert');
const { withWorld, secretsPeople, secretsNeedlesFor, checkSecretsStored } = require('./security-suite');

withWorld('secrets-storage', async (w) => {
    const needlesFor = secretsNeedlesFor(w, secretsPeople(w));
    for (const s of w.shownOnce.filter((x) => x.status >= 200 && x.status < 300)) assert.match(s.cache, /no-store/, `${s.what}: Cache-Control no-store`);
    assert.ok(w.shownOnce.filter((x) => x.status >= 200 && x.status < 300).length >= 6, 'the shown-once responses were made');
    for (const [who, m, p, body] of [['alice', 'POST', '/api/auth/refresh', {}], [null, 'POST', '/api/auth/anon-session', {}], [null, 'GET', '/api/auth/anon-identities'], [null, 'POST', '/api/auth/login', { username: 'alice', password: 'wrong' }]]) {
        const r = await w.call(who, m, p, body);
        assert.match(r.headers.get('cache-control') || '', /no-store/, `${m} ${p} (${r.status}): Cache-Control no-store`);
    }

    await checkSecretsStored(w, needlesFor);
}).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
