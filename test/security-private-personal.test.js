'use strict';
// Personal data, private modules, follows and blocks stay private across the route crawl.
const assert = require('assert');
const { withWorld, privateCrawl, privateMine, checkPrivateStatuses } = require('./security-suite');

withWorld('private-personal', async (w) => {
    const { users } = w;
    const { res } = await privateCrawl(w, 'personal');
    checkPrivateStatuses(w, res);

    // Positive controls: the owners of the data do see it, so the needles are real.
    await privateMine(w, 'alice', '/api/auth/me', users.alice.email);
    await privateMine(w, 'alice', '/api/modules/ai.preferences', 'alice-private-perspective');
    await privateMine(w, 'alice', '/api/notifications', 'alice-private-notification');
    await privateMine(w, 'alice', '/api/auth/sessions', 'alice-laptop');
    await privateMine(w, 'alice', '/api/history', 'alice-private-history');
    // The linked-account positive control was deleted with the retired internal key.
    const pub = await w.call(null, 'GET', '/api/v1/status/incidents');
    assert.strictEqual(pub.status, 200);
    assert.ok(!pub.text.includes('long-closed-incident-title'), 'an incident closed 40 days ago is not listed');

    // Blocks and follows are the person's own: bob cannot list alice's, only count public follows.
    await w.call('alice', 'PUT', `/api/v1/me/follows/channel/${users.owner.subject}`, {});
    let r = await w.call('bob', 'GET', '/api/v1/me/blocks');
    assert.ok(!r.text.includes(users.carol.subject), 'bob does not see who alice blocks');
    r = await w.call('bob', 'GET', '/api/v1/me/follows');
    assert.ok(!r.text.includes(users.owner.subject), 'bob does not see whom alice follows');
    r = await w.call('bob', 'GET', `/api/v1/follows/channel/${users.owner.subject}/followers`);
    assert.ok(r.status === 403 || r.status === 404, `followers of someone else are not bob's to list (${r.status})`);
    assert.ok(!r.text.includes(users.alice.subject));
    r = await w.call('owner', 'GET', `/api/v1/follows/channel/${users.owner.subject}/followers`);
    assert.ok(r.status === 200 && r.text.includes(users.alice.subject), 'the target lists its own followers (positive control)');
    r = await w.call('alice', 'GET', '/api/v1/me/blocks');
    assert.ok(r.text.includes(users.carol.subject), 'alice lists her own blocks (positive control)');
    // Public module reads carry only a namespace's public fields.
    r = await w.call('bob', 'GET', `/api/modules/ai.preferences/public/${users.alice.subject}`);
    assert.ok(!r.text.includes('alice-private-perspective') && !r.text.includes('casual'), `public module read carries no private field (${r.status})`);
}).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
