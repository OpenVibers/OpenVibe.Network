/**
 * Actor's grant on OpenVibe.AI runs ai.complete and video.analyze (plan §Z.9, 11-13): an agent's video_analyze tool
 * watches a video the person may read. The seed never changes an existing row, so production's row (['ai.complete'])
 * must be moved at boot; a row someone edited by hand is left alone.
 *
 *   node test/actor-video-analyze-grant.test.js
 */
'use strict';
const assert = require('assert');
const { getDb } = require('../server/db/database');
const principals = require('../server/identity/principals');

(async () => {
    const db = getDb();
    await principals.ensureSchema(db);
    const where = "client_id = 'actor' AND capability = 'ai.run.create' AND audience = 'openvibe.ai'";
    const row = async () => JSON.parse((await db.prepare(`SELECT namespaces FROM principal_grants WHERE ${where}`).get()).namespaces);
    assert.deepStrictEqual(await row(), ['ai.complete', 'video.analyze'], 'a fresh database gets both');

    // Production's row, as the old default seeded it.
    await db.prepare(`UPDATE principal_grants SET namespaces = ? WHERE ${where}`).run(JSON.stringify(['ai.complete']));
    await principals.ensureSchema(db);
    assert.deepStrictEqual(await row(), ['ai.complete', 'video.analyze'], 'the old default row is moved at boot');

    // A row edited by hand stays as it was.
    await db.prepare(`UPDATE principal_grants SET namespaces = ? WHERE ${where}`).run(JSON.stringify(['ai.complete', 'custom.x']));
    await principals.ensureSchema(db);
    assert.deepStrictEqual(await row(), ['ai.complete', 'custom.x'], 'an edited row is left alone');
    console.log('actor video.analyze grant: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
