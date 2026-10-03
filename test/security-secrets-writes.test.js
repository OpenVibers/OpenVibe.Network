'use strict';
// Refused and malformed write routes must never reveal secrets.
const assert = require('assert');
const jwt = require('jsonwebtoken');
const crawler = require('./security-crawl');
const { withWorld, out, secretsValues, secretsPeople, secretsNeedlesFor, secretsPaths, checkSecretsStored } = require('./security-suite');

withWorld('secrets-writes', async (w) => {
    const { users, dev } = w;
    const paths = secretsPaths(w);
    const people = secretsPeople(w);
    const needlesFor = secretsNeedlesFor(w, people);
    const writes = {};
    for (const m of ['post', 'put', 'patch', 'delete']) writes[m] = crawler.pathsFor(w.routes, (name) => secretsValues(w, name), { method: m });
    const found = [];
    let sent = 0;
    for (const [m, list] of Object.entries(writes)) {
        const M = m.toUpperCase();
        for (const [body, callers] of [
            ['{"broken": ', people],
            ['{}', { anonymous: {}, app: people.app || {} }],
        ]) {
            const r = await crawler.crawl(w.srv.base, list, callers, needlesFor, { method: M, body });
            sent += list.length * Object.keys(callers).length;
            found.push(...r.found);
        }
    }
    const wrong = {
        'retired internal key': { 'x-internal-key': 'retired-key' },
        'forged bearer': { authorization: `Bearer ${jwt.sign({ sub: users.owner.id, id: users.owner.id }, 'guess', { issuer: w.issuer })}` },
        'none alg bearer': { authorization: `Bearer ${jwt.sign({ sub: users.owner.id, id: users.owner.id }, null, { algorithm: 'none' })}` },
        'setup token guess': { 'x-setup-token': 'x', authorization: 'Bearer x' },
    };
    const wr = await crawler.crawl(w.srv.base, [...writes.post.filter((p) => /^\/(internal|oauth|api\/setup|api\/admin)/.test(p)), ...paths.filter((p) => /^\/(internal|api\/admin)/.test(p))], wrong, needlesFor, { method: 'GET' });
    found.push(...wr.found);
    for (const [grant, form] of [
        ['client_credentials', { client_id: 'live', client_secret: 'wrong' }],
        ['client_credentials', { client_id: dev.PA.clientId, client_secret: 'ovsec_wrong' }],
        ['authorization_code', { client_id: 'live', client_secret: w.clientSecrets.live, code: 'nope', redirect_uri: 'https://evil.test/' }],
        ['refresh_token', { client_id: 'live', client_secret: w.clientSecrets.live, refresh_token: 'f'.repeat(96) }],
    ]) {
        const r = await w.call(null, 'POST', '/oauth/token', new URLSearchParams({ grant_type: grant, ...form }));
        assert.ok(r.status >= 400, `${grant} with wrong material is refused`);
        for (const l of crawler.leaks(r, needlesFor('anonymous'))) found.push(`oauth ${grant} refusal carries ${l.label}`);
    }
    out(`write/error crawl: ${sent} requests`);
    assert.deepStrictEqual(found, [], `secrets in error responses:\n${found.join('\n')}`);
    await checkSecretsStored(w, needlesFor);
}).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
