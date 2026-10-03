'use strict';
// Crawl every GET route for secrets and verify owner-only reads and JWKS.
const assert = require('assert');
const crypto = require('crypto');
const crawler = require('./security-crawl');
const { withWorld, out, secretsPeople, secretsNeedlesFor, secretsPaths, checkSecretsStored } = require('./security-suite');

withWorld('secrets-reads', async (w) => {
    const paths = secretsPaths(w);
    const people = secretsPeople(w);
    const needlesFor = secretsNeedlesFor(w, people);
    const gets = await crawler.crawl(w.srv.base, paths, people, needlesFor);
    out(`GET crawl: ${paths.length} paths x ${Object.keys(people).length} callers, ${JSON.stringify(gets.statuses)}`);
    // The owner, and only the owner, reads provider secrets and secret-typed registry values in clear.
    const OWNER_READS = /^owner: GET \/api\/admin\/(settings|url-registry)(\?[^ ]*)? → 200 carries (db setting [a-z_.]+|env DEPLOY_CLOUDFLARE_TOKEN) in its body$/;
    const ownerReads = gets.found.filter((f) => OWNER_READS.test(f));
    assert.ok(ownerReads.length > 0, 'the owner exception is still exercised');
    for (const p of ['/api/admin/settings', '/api/admin/url-registry']) {
        const r = await w.call(people.owner, 'GET', p);
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('cache-control') || '', /no-store/, `${p}: the owner's clear-text read is never cached`);
        const staff = await w.call(people.admin, 'GET', p);
        assert.ok(staff.status === 403 || (staff.status === 200 && crawler.leaks(staff, needlesFor('admin')).length === 0), `${p}: staff admins get it masked or not at all`);
    }
    const leaked = gets.found.filter((f) => !OWNER_READS.test(f));
    assert.deepStrictEqual(leaked, [], `secrets in GET responses:\n${leaked.join('\n')}`);
    assert.ok(paths.length >= 300 && gets.answered === paths.length * Object.keys(people).length, 'every request was answered');
    assert.ok((gets.statuses['2xx'] || 0) > 500, 'the crawl reached real pages, not only refusals');
    assert.strictEqual(Object.values(gets.byPath).filter((s) => s === 429).length, 0, 'no request was rate-limited away');
    const st = (who, p) => gets.byPath[`${who} GET ${p}`];
    assert.strictEqual(st('user', '/api/auth/me'), 200);
    assert.strictEqual(st('anonymous', '/api/auth/me'), 401);
    assert.strictEqual(st('admin', '/api/admin/url-registry'), 200);
    assert.strictEqual(st('admin', '/api/admin/settings'), 403, 'settings are the owner\'s');
    assert.strictEqual(st('user', '/api/admin/url-registry'), 403);
    assert.strictEqual(st('owner', '/api/admin/secrets'), 200);
    assert.strictEqual(st('owner', '/api/admin/settings'), 200);
    assert.strictEqual(st('service', '/internal/url-registry/resolved'), 200, 'live may read the resolved registry');
    assert.strictEqual(st('key', '/internal/url-registry/resolved'), 401, 'the retired X-Internal-Key opens nothing');
    assert.strictEqual(st('anonymous', '/internal/url-registry/resolved'), 401, 'and nobody without a service token gets in');

    const jwks = await w.call(null, 'GET', '/api/.well-known/jwks');
    assert.strictEqual(jwks.status, 200);
    assert.ok(jwks.body.public_key.includes('BEGIN PUBLIC KEY') && jwks.body.keys.length === 1);
    for (const f of ['d', 'p', 'q', 'dp', 'dq', 'qi']) assert.ok(!(f in jwks.body.keys[0]), `JWKS has no private member ${f}`);
    const jwk = jwks.body.keys[0];
    assert.strictEqual(jwk.kty, 'RSA');
    assert.strictEqual(jwk.kid, 'ov-network-1', 'the kid /api/.well-known/jwks publishes');
    assert.strictEqual(jwk.n, crypto.createPublicKey(w.keys.publicKey).export({ format: 'jwk' }).n, 'the modulus is the configured key\'s');
    assert.ok(!/PRIVATE/.test(jwks.text));
    await checkSecretsStored(w, needlesFor);
}).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
