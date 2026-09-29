'use strict';
// Private bypass (roadmap WS-R task 5). With the seeded world of test/security-world.js, alice's
// private data (her email, module data, notification, session device, linked account, history, push
// endpoint, the people she blocks and follows) and the developer projects (names, apps, members,
// credentials, usage, audit) are private; so are /internal/* and the staff pages. Every GET route
// Express knows after boot is crawled as anonymous, bob (another user), a developer app and a service
// principal: no answer may carry alice's private data, a project's private data to a non-member, or
// an incident closed long ago. Then, by status: /internal/* never answers 2xx without a valid key or
// capability token, staff pages never answer non-staff, a non-member gets 404 (existence not
// disclosed) on every read of a project, its apps, members, credentials, grants, quotas, usage and
// audit, and anonymous gets 401.
//   node test/security-private.test.js
const assert = require('assert');
const { buildWorld } = require('./security-world');
const crawler = require('./security-crawl');

const out = (...a) => process.stdout.write(a.join(' ') + '\n');

(async () => {
    const t0 = Date.now();
    const w = await buildWorld({ label: 'private' });
    try {
        const { users, dev, db } = w;
        // An incident closed 40 days ago is gone from the public page (recent = the last 30 days).
        const inc = await w.call('staff', 'POST', '/api/v1/status/incidents', { kind: 'incident', title: 'long-closed-incident-title', severity: 'minor', state: 'investigating', services: ['network'], message: 'x' });
        assert.strictEqual(inc.status, 201, inc.text);
        const closed = await w.call('staff', 'POST', `/api/v1/status/incidents/${inc.body.id}/updates`, { state: 'resolved', message: 'fixed' });
        assert.strictEqual(closed.status, 200, closed.text);
        const longAgo = new Date(Date.now() - 40 * 864e5).toISOString();
        db.prepare('UPDATE status_incidents SET starts_at = ?, updated_at = ?, ends_at = ? WHERE id = ?').run(longAgo, longAgo, longAgo, inc.body.id);
        db.prepare('UPDATE status_incident_updates SET at = ? WHERE incident_id = ?').run(longAgo, inc.body.id);

        const alice = {
            'alice email': users.alice.email,
            'alice module data': 'alice-private-perspective',
            'alice notification': 'alice-private-notification',
            'alice session device': 'alice-laptop',
            'alice linked account': 'alice-games-771',
            'alice history': 'alice-private-history',
            'alice push endpoint': w.pushSub.endpoint,
            'alice project': 'alice-private-project',
            'alice app': 'alice-private-app',
            'bob project': 'bob-private-project',
            'bob app': 'bob-private-app',
            'long-closed incident': 'long-closed-incident-title',
            'carol email': users.carol.email,
            'staff email': users.staff.email,
        };
        const values = (name) => ({
            project: [dev.PA.id, 'prj_00000000000000000000000000'],
            app: [dev.PA.app, 'app_00000000000000000000000000'],
            credential: [dev.PA.credential, 'crd_x'],
            capability: ['media.object.upload', 'x'],
            subject: [users.alice.subject, 'usr_x'],
            target: [users.alice.subject, users.carol.subject, 'x'],
            type: ['user', 'channel'],
            creator: [users.alice.subject, 'alice'],
            id: [String(users.alice.id), String(users.carol.id), '1', 'x'],
            userId: [String(users.alice.id), String(users.carol.id)],
            username: ['alice', 'carol'],
            name: ['alice', 'carol'],
            ns: ['ai.preferences', 'chat.tts_defaults', 'x'],
            namespace: ['general', 'x'],
            token: ['x'],
            idOrSlug: ['default', 'x'],
            serviceId: ['live', 'x'],
            domain: ['openvibe.live'],
            topic: ['live.stream.started'],
            category: ['system'],
            key: ['OV_LIVE_URL'],
        }[name] || ['1']);
        const paths = crawler.pathsFor(w.routes, values, { method: 'get', query: 'all=1&limit=100&user_id=' + users.alice.id + '&subject=' + users.alice.subject, extra: ['/api/v1/projects?all=1', '/api/v1/status/incidents'] });
        // bob is not a member of alice's project and bob's own project is his: his own names are not needles for him.
        const people = { anonymous: w.callers.anonymous, user: w.callers.user, app: w.callers.app, service: w.callers.service };
        assert.ok(people.app && people.app.authorization, 'a developer app token to crawl with');
        const needlesFor = (who) => {
            const n = { ...alice };
            if (who === 'user') { delete n['bob project']; delete n['bob app']; }
            return n;
        };
        const res = await crawler.crawl(w.srv.base, paths, people, needlesFor);
        out(`private crawl: ${paths.length} paths x ${Object.keys(people).length} callers, ${JSON.stringify(res.statuses)}`);
        assert.deepStrictEqual(res.found, [], `private data reached the wrong caller:\n${res.found.join('\n')}`);
        assert.ok(res.answered === paths.length * Object.keys(people).length && (res.statuses['2xx'] || 0) > 200);

        // Positive controls: the owners of the data do see it, so the needles are real.
        const mine = async (who, p, needle) => { const r = await w.call(who, 'GET', p); assert.ok(r.text.includes(needle), `${who} sees ${needle} at ${p} (${r.status})`); };
        await mine('alice', '/api/auth/me', users.alice.email);
        await mine('alice', '/api/modules/ai.preferences', 'alice-private-perspective');
        await mine('alice', '/api/notifications', 'alice-private-notification');
        await mine('alice', '/api/auth/sessions', 'alice-laptop');
        await mine('alice', '/api/history', 'alice-private-history');
        await mine('alice', `/api/v1/projects/${dev.PA.id}`, 'alice-private-project');
        await mine('alice', `/api/v1/projects/${dev.PA.id}/apps`, 'alice-private-app');
        // (The linked-account needle's positive control was GET /internal/users/:id/linked-accounts, deleted with the key
        // in plan T2; the needle stays in the crawl so any route that exposes it to the wrong caller still fails.)
        const pub = await w.call(null, 'GET', '/api/v1/status/incidents');
        assert.strictEqual(pub.status, 200);
        assert.ok(!pub.text.includes('long-closed-incident-title'), 'an incident closed 40 days ago is not listed');

        // ── By status ─────────────────────────────────────────────────
        const st = res.byPath;
        const bad = [];
        for (const [k, s] of Object.entries(st)) {
            const [who, , p] = k.split(' ');
            const path = p.split('?')[0];
            if (who === 'service') continue;
            // /internal/*: a key or a capability token, else never 2xx (and never a redirect into it).
            if (/^\/internal\//.test(path) && s < 400) bad.push(`${k} → ${s}`);
            // Staff and admin pages: never 2xx for these callers.
            // (/api/v1/staff/capabilities is the caller's own: empty for non-staff.)
            if (/^\/api\/(admin|v1\/staff)\//.test(path) && path !== '/api/v1/staff/capabilities' && s < 400) bad.push(`${k} → ${s}`);
            // Alice's project: anonymous 401, others 404 (existence not disclosed).
            if (path.startsWith(`/api/v1/projects/${dev.PA.id}`)) {
                const want = who === 'anonymous' || who === 'app' ? [401] : [404];
                if (!want.includes(s)) bad.push(`${k} → ${s} (want ${want})`);
            }
            // Personal lists: anonymous and apps are refused.
            // (/api/modules/:ns/public/:subject is public by design: only a namespace's public fields.)
            if (/^\/api\/(notifications|history|modules|coins\/me|push\/status|auth\/sessions|auth\/me|v1\/me\/)/.test(path) && !/^\/api\/modules\/[^/]+\/public\//.test(path) && who !== 'user' && s < 400) bad.push(`${k} → ${s}`);
        }
        assert.deepStrictEqual(bad, [], `private reads answered:\n${bad.join('\n')}`);
        // A service principal reaches only the /internal routes its capabilities name.
        assert.strictEqual(st['service GET /internal/integrations/github-token'], 403, 'github-token needs the legacy key or its own capability');
        // Deleted with the X-Internal-Key retirement (plan T2, no caller left): no longer routes at all.
        for (const p of ['/internal/stats', `/internal/users/${users.alice.id}`, `/internal/users/${users.alice.id}/linked-accounts`, '/internal/anon-list', `/internal/notifications/unread/${users.alice.id}`]) {
            assert.strictEqual(st[`service GET ${p}`], undefined, `${p} is gone`);
        }

        // Lists and search: bob's view of projects never includes alice's, even asking for all.
        for (const p of ['/api/v1/projects', '/api/v1/projects?all=1']) {
            const r = await w.call('bob', 'GET', p);
            assert.strictEqual(r.status, 200);
            assert.ok(r.body.projects.every((x) => x.id !== dev.PA.id), `${p}: alice's project is not listed to bob`);
        }
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
        // A developer app token opens no person's API and no project API.
        for (const p of ['/api/auth/me', '/api/notifications', '/api/v1/projects', `/api/v1/projects/${dev.PA.id}`, '/api/modules/ai.preferences']) {
            r = await w.call(people.app, 'GET', p);
            assert.strictEqual(r.status, 401, `${p}: an app token is not a person's session`);
        }
        out(`security private: all checks passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } finally {
        await w.stop();
    }
})().catch((err) => { console.error(err); process.exit(1); });
