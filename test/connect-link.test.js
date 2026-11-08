'use strict';
const assert = require('node:assert/strict');
const { getDb, seedDb } = require('../server/db/database');
const { isTrustedHost, isTrustedOrigin, clientOriginMatcher } = require('../server/auth/sso-owned');
const { siteForHost, SITES } = require('../server/frame/sites');
(async () => {
    const db = await getDb();
    await db.prepare("UPDATE oauth_clients SET client_secret = ?, redirect_uris = ? WHERE client_id = 'connect'")
        .run('test-connect-credential', JSON.stringify(['https://connect.openvibe.website/auth/callback', 'https://existing.example/callback']));
    await seedDb(db, { log: { log() {}, warn() {} } });
    await seedDb(db, { log: { log() {}, warn() {} } });
    const c = await db.prepare("SELECT * FROM oauth_clients WHERE client_id = 'connect'").get();
    assert.equal(c.client_secret, 'test-connect-credential');
    assert.deepEqual(JSON.parse(c.redirect_uris), ['https://connect.openvibe.website/auth/callback', 'https://existing.example/callback', 'https://connect.openvibe.link/auth/callback']);
    const matches = clientOriginMatcher(c);
    for (const host of ['connect.openvibe.link', 'connect.openvibe.website']) {
        assert.equal(isTrustedHost(host), true); assert.equal(isTrustedOrigin(`https://${host}`), true);
        assert.equal(matches(`https://${host}`), true);
        assert.equal(siteForHost(host).service, 'connect');
    }
    for (const host of ['portal--alex.openvibe.link', 'portal--alex.openvibe.website', 'nested.portal--alex.openvibe.link', 'connect.openvibe.link.evil.example']) {
        assert.equal(isTrustedHost(host), false, host); assert.equal(isTrustedOrigin(`https://${host}`), false, host);
        assert.equal(matches(`https://${host}`), false, host); assert.equal(siteForHost(host), null, host);
    }
    assert.equal(SITES.find(s => s.service === 'connect').host, 'connect.openvibe.link');
    assert.equal(isTrustedHost('openvibe.link'), true);
    console.log('Connect Link callbacks, credential preservation, frame destination and tenant isolation passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
