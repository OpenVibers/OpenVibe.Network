'use strict';
// Other GET routes, internal capabilities and retired internal endpoints.
const assert = require('assert');
const { withWorld, privateCrawl, checkPrivateStatuses } = require('./security-suite');

withWorld('private-platform', async (w) => {
    const { users } = w;
    const { res } = await privateCrawl(w, 'platform');
    checkPrivateStatuses(w, res);
    const st = res.byPath;
    // A service principal reaches only the /internal routes its capabilities name.
    assert.strictEqual(st['service GET /internal/integrations/github-token'], 403, 'github-token needs its own capability');
    // Deleted when the shared key was retired (plan T2, no caller left): no longer routes at all.
    for (const p of ['/internal/stats', `/internal/users/${users.alice.id}`, `/internal/users/${users.alice.id}/linked-accounts`, '/internal/anon-list', `/internal/notifications/unread/${users.alice.id}`]) {
        assert.strictEqual(st[`service GET ${p}`], undefined, `${p} is gone`);
    }
}).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
