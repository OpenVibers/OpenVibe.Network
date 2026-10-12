'use strict';
// A default grant that code revoked (REVOKED_GRANTS) and later made a default again comes back at boot only when it is
// named in RESTORED_GRANTS; a grant a person revoked stays revoked. (2026-10-12: Space's events.event.publish stayed
// revoked after Network#160 because the seed inserts with ON CONFLICT DO NOTHING.)
const assert = require('assert');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');

(async () => {
    const db = await getDb();
    await principals.ensureSchema(db);
    const key = (g) => g.slice(0, 3).join(' ');
    const defaults = new Set(principals.DEFAULT_GRANTS.map(key));
    const revoked = new Set(principals.REVOKED_GRANTS.map(key));
    for (const g of principals.RESTORED_GRANTS) {
        assert.ok(defaults.has(key(g)), `${key(g)} is restored, so it must be a default grant`);
        assert.ok(!revoked.has(key(g)), `${key(g)} is restored, so it must not be revoked`);
    }
    const row = (c, cap, aud) => db.prepare('SELECT revoked_at FROM principal_grants WHERE client_id = ? AND capability = ? AND audience = ?').get(c, cap, aud);
    const [client, cap, aud] = principals.RESTORED_GRANTS[0];
    assert.ok(await db.prepare('SELECT 1 FROM oauth_clients WHERE client_id = ?').get(client), `the ${client} client is seeded`);
    {
        await db.prepare('UPDATE principal_grants SET revoked_at = ov_now() WHERE client_id = ? AND capability = ? AND audience = ?').run(client, cap, aud);
        await principals.ensureSchema(db);
        assert.strictEqual((await row(client, cap, aud)).revoked_at, null, 'the restored default grant is live again after boot');
    }
    // A default grant that is not in RESTORED_GRANTS and was revoked (by a person, through grants-admin) stays revoked.
    const other = principals.DEFAULT_GRANTS.find((g) => !principals.RESTORED_GRANTS.some((r) => key(r) === key(g)) && g[0] === 'host');
    await db.prepare('UPDATE principal_grants SET revoked_at = ov_now() WHERE client_id = ? AND capability = ? AND audience = ?').run(other[0], other[1], other[2]);
    await principals.ensureSchema(db);
    const kept = await row(other[0], other[1], other[2]);
    assert.ok(!kept || kept.revoked_at, 'a grant someone revoked is never restored by boot');
    console.log('restored grants: a named default grant comes back; any other revoked grant stays revoked');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
