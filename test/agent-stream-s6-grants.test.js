'use strict';
/**
 * The Agent Streams plan (S6, Contracts 0.304.0): who may work the chat plays queue of a person's agent stream.
 *
 * Codes reads the queue of the owner's room on OpenVibe.Chat (chat.play_queue.read) and writes how each
 * request ran (chat.play_queue.write), for the audience openvibe.chat and nobody else. The capability is
 * named by a contracts release that is not out yet, so the rows are seeded from PENDING_GRANTS: a grant is a
 * row, and the token issuer hands it out. The pin round, which moves this repository to the release that
 * names the capability, is what makes the contract check know it.
 *
 *   node test/agent-stream-s6-grants.test.js
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { getDb } = require('../server/db/database');

const READ = 'chat.play_queue.read';
const WRITE = 'chat.play_queue.write';
const AUDIENCE = 'openvibe.chat';

(async () => {
    const principals = require('../server/identity/principals');

    // The rows: Codes holds both, for Chat's audience alone, with no namespace of its own. They are ordinary
    // default grants: the contracts release that names the capability (v0.304.0) is out and this repository is
    // pinned to it, so every default grant names a capability the pinned contracts know.
    const rows = principals.DEFAULT_GRANTS.filter((g) => g[1] === READ || g[1] === WRITE);
    assert.strictEqual(rows.length, 2, 'the queue grants are the two rows of the plan');
    for (const cap of [READ, WRITE]) {
        const g = rows.find((r) => r[1] === cap);
        assert.ok(g, 'Codes holds ' + cap);
        assert.strictEqual(g[0], 'codes', cap + ' is Codes\'s');
        assert.strictEqual(g[2], AUDIENCE, cap + ' is for Chat\'s audience');
        assert.deepStrictEqual(g[3], [], cap + ' is unscoped');
        assert.ok(contracts.capabilities.get(cap), 'the pinned contracts know ' + cap);
    }
    assert.ok(!principals.DEFAULT_GRANTS.some((g) => g[1] === READ || g[1] === WRITE) === false,
        'the queue grants are default grants');
    assert.ok(!principals.DEFAULT_GRANTS.some((g) => (g[1] === READ || g[1] === WRITE) && g[0] !== 'codes'),
        'no other service holds the queue');
    assert.ok(!principals.DEFAULT_GRANTS.some((g) => (g[1] === READ || g[1] === WRITE) && g[2] !== AUDIENCE),
        'the queue is Chat\'s and no other audience');
    assert.ok(!principals.REVOKED_GRANTS.some((g) => g[1] === READ || g[1] === WRITE), 'the queue grants are not revoked');

    // The rows are seeded, so the token issuer hands them out.
    const db = await getDb();
    await principals.ensureSchema(db);
    const held = (await principals.grantsFor(db, 'codes', AUDIENCE)).map((g) => g.capability);
    for (const cap of [READ, WRITE]) assert.ok(held.includes(cap), 'Codes holds ' + cap + ' on Chat');

    // The capability, when the pin carries it, is Chat's and is active.
    for (const cap of [READ, WRITE]) {
        const known = contracts.capabilities.get(cap);
        if (known) {
            assert.strictEqual(known.owner, 'chat', cap + ' is Chat\'s capability');
            assert.strictEqual(known.status, 'active', cap + ' is active');
        } else {
            console.log('note: the pinned contracts do not know ' + cap + ' yet (the pin round lands it)');
        }
    }
    console.log('chat plays grants: Codes works the queue of the owner\'s room on Chat, and for no other audience');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
