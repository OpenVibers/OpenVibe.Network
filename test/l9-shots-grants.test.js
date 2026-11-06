'use strict';
// Plan L9 (2026-11-06): the screenshot pass. Host stores the shots ovhost captures in OpenVibe.Media, in its own
// tenant, and Blog reads them to put a before/after in the patch notes. Both are default grants.
const assert = require('assert');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');

const HOST_CAPS = ['media.object.upload', 'media.object.read', 'media.object.list', 'media.object.delete'];

(async () => {
    const db = await getDb();
    await principals.ensureSchema(db);

    for (const cap of HOST_CAPS) {
        const def = principals.DEFAULT_GRANTS.find((g) => g[0] === 'host' && g[1] === cap && g[2] === 'openvibe.media');
        assert.ok(def, `host's ${cap} grant on openvibe.media is a default grant`);
        assert.deepStrictEqual(def[3], ['host'], `host's ${cap} grant is on the host namespace alone`);
        assert.ok(!principals.REVOKED_GRANTS.some((g) => g[0] === 'host' && g[1] === cap && g[2] === 'openvibe.media'),
            `host's ${cap} grant is not revoked any more`);
        assert.ok(principals.RESTORED_GRANTS.some((g) => g[0] === 'host' && g[1] === cap && g[2] === 'openvibe.media'),
            `host's ${cap} grant comes back at boot (it is named in RESTORED_GRANTS)`);
    }

    // The rows are live after boot: not revoked, on the host namespace.
    for (const cap of HOST_CAPS) {
        const row = await db.prepare('SELECT revoked_at, namespaces FROM principal_grants WHERE client_id = ? AND capability = ? AND audience = ?')
            .get('host', cap, 'openvibe.media');
        assert.ok(row, `the ${cap} row exists`);
        assert.strictEqual(row.revoked_at, null, `${cap} is not revoked`);
        assert.deepStrictEqual(JSON.parse(row.namespaces || '[]'), ['host'], `${cap} is on the host namespace`);
    }

    // Blog reads its own tenant and Host's, so the patch notes can read the shots.
    const blog = await db.prepare('SELECT revoked_at, namespaces FROM principal_grants WHERE client_id = ? AND capability = ? AND audience = ?')
        .get('blog', 'media.object.read', 'openvibe.media');
    assert.ok(blog, "blog's Media read grant exists");
    const ns = JSON.parse(blog.namespaces || '[]');
    assert.ok(ns.includes('blog') && ns.includes('host'), `blog reads its own tenant and Host's: ${JSON.stringify(ns)}`);
    assert.strictEqual(blog.revoked_at, null, "blog's Media read grant is live");

    console.log('l9 shots grants: Host owns its Media tenant again; Blog can read the shots');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
