'use strict';
// Project details, lists and app tokens respect membership and session boundaries.
const assert = require('assert');
const { withWorld, privateCrawl, privateMine, checkPrivateStatuses } = require('./security-suite');

withWorld('private-projects', async (w) => {
    const { dev } = w;
    const { res, people } = await privateCrawl(w, 'projects');
    checkPrivateStatuses(w, res);
    await privateMine(w, 'alice', `/api/v1/projects/${dev.PA.id}`, 'alice-private-project');
    await privateMine(w, 'alice', `/api/v1/projects/${dev.PA.id}/apps`, 'alice-private-app');

    // Lists and search: bob's view of projects never includes alice's, even asking for all.
    for (const p of ['/api/v1/projects', '/api/v1/projects?all=1']) {
        const r = await w.call('bob', 'GET', p);
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.projects.every((x) => x.id !== dev.PA.id), `${p}: alice's project is not listed to bob`);
    }
    // A developer app token opens no person's API and no project API.
    for (const p of ['/api/auth/me', '/api/notifications', '/api/v1/projects', `/api/v1/projects/${dev.PA.id}`, '/api/modules/ai.preferences']) {
        const r = await w.call(people.app, 'GET', p);
        assert.strictEqual(r.status, 401, `${p}: an app token is not a person's session`);
    }
}).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
