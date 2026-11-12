/**
 * Design's AI grant reaches the row production already has (11-02): Design's frames with a preference run AI's ai.chat
 * workflow, and the default grant names ai.generate and ai.chat. The seed never changes an existing row, so a row
 * seeded before with ['ai.generate'] must be moved at boot; a row someone edited by hand is left alone.
 *
 *   node test/design-ai-chat-grant.test.js
 */
'use strict';
const assert = require('assert');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');

(async () => {
    const db = getDb();
    await principals.ensureSchema(db);
    const row = async () => JSON.parse((await db.prepare("SELECT namespaces FROM principal_grants WHERE client_id = 'design' AND capability = 'ai.run.create' AND audience = 'openvibe.ai'").get()).namespaces);
    assert.deepStrictEqual((await row()).sort(), ['ai.chat', 'ai.generate', 'design.deep_dive'], 'a fresh database gets the frames and the deep dive');

    // Production's row, as the old default seeded it.
    await db.prepare("UPDATE principal_grants SET namespaces = ? WHERE client_id = 'design' AND capability = 'ai.run.create' AND audience = 'openvibe.ai'").run(JSON.stringify(['ai.generate']));
    await principals.ensureSchema(db);
    assert.deepStrictEqual(await row(), ['ai.generate', 'ai.chat', 'design.deep_dive'], 'the old default row is moved at boot, through both moves');

    // A row edited by hand stays as it was.
    await db.prepare("UPDATE principal_grants SET namespaces = ? WHERE client_id = 'design' AND capability = 'ai.run.create' AND audience = 'openvibe.ai'").run(JSON.stringify(['ai.generate', 'custom.x']));
    await principals.ensureSchema(db);
    assert.deepStrictEqual(await row(), ['ai.generate', 'custom.x'], 'an edited row is left alone');
    console.log('design ai.chat grant: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
