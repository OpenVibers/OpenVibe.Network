'use strict';
// IDOR (roadmap WS-R task 5): ids swapped between two people, two developer projects and two apps,
// and service principals acting outside their own app. With the seeded world of
// test/security-world.js (alice owns project PA with app AA, bob owns PB with AB):
//   - bob tries every write route of alice's project with its ids: rename, archive, allowance,
//     environment policy, members (add himself as owner, demote or remove alice), apps (create, edit,
//     revoke), credentials (rotate, revoke), grants (request, approve, deny, revoke), quotas, export
//     tokens; and the same ids under his own project's paths (PB/apps/AA, PB/apps/AB/credentials/<AA's>)
//   - bob tries alice's notifications (read, dismiss, batch), session (revoke), history entry, profile
//     (ids in the body), modules, follows, blocks and push subscription
//   - a service principal pushes a notification, credits coins, links an account, writes a module and
//     maps legacy ids for another app or system
// Every refusal leaves the database as it was (the rows are compared before and after), carries no
// token or secret, and positive controls show each route works for its owner.
//   node test/security-idor.test.js
const assert = require('assert');
const { buildWorld } = require('./security-world');
const crawler = require('./security-crawl');

const out = (...a) => process.stdout.write(a.join(' ') + '\n');

(async () => {
    const t0 = Date.now();
    const w = await buildWorld({ label: 'idor' });
    try {
        const { users, dev, db } = w;
        const PA = dev.PA.id; const AA = dev.PA.app; const PB = dev.PB.id; const AB = dev.PB.app;
        const DEV_TABLES = ['dev_projects', 'dev_project_members', 'dev_apps', 'dev_credentials', 'dev_grants', 'dev_quotas'];
        const snap = async (tables, where = {}) => JSON.stringify((await Promise.all(tables.map(async (t) => await db.prepare(`SELECT * FROM "${t}" ${where[t] || ''}`).all()))));
        const secretNeedles = { ...w.secrets };
        const refused = [];
        const expectRefused = async (who, method, p, body, { tables, where, codes = [401, 403, 404] } = {}) => {
            const before = tables ? await snap(tables, where) : null;
            const r = await w.call(who, method, p, body);
            if (!codes.includes(r.status)) refused.push(`${method} ${p} as ${typeof who === 'string' ? who : 'token'} → ${r.status} ${r.text.slice(0, 160)}`);
            if (tables && await snap(tables, where) !== before) refused.push(`${method} ${p}: the database changed on a refusal`);
            for (const l of crawler.leaks(r, secretNeedles)) refused.push(`${method} ${p}: the refusal carries ${l.label}`);
            if (/"(client_secret|access_token|refresh_token)"/.test(r.text)) refused.push(`${method} ${p}: the refusal carries a token field`);
            return r;
        };
        const ok = async (who, method, p, body, status = [200, 201, 204]) => {
            const r = await w.call(who, method, p, body);
            assert.ok([].concat(status).includes(r.status), `positive control ${method} ${p}: ${r.status} ${r.text.slice(0, 200)}`);
            return r;
        };

        // ── Developer projects: bob against alice's ids ──────────────────
        const devWrites = [
            ['PATCH', `/api/v1/projects/${PA}`, { name: 'pwned' }],
            ['POST', `/api/v1/projects/${PA}/archive`, {}],
            ['PUT', `/api/v1/projects/${PA}/allowance`, { capabilities: ['network.coins.credit'] }],
            ['PUT', `/api/v1/projects/${PA}/environment-policy`, { policy: 'sandbox+production' }],
            ['POST', `/api/v1/projects/${PA}/members`, { username: 'bob', role: 'owner' }],
            ['PATCH', `/api/v1/projects/${PA}/members/${users.alice.subject}`, { role: 'viewer' }],
            ['DELETE', `/api/v1/projects/${PA}/members/${users.alice.subject}`],
            ['POST', `/api/v1/projects/${PA}/apps`, { name: 'bob-in-alice', environment: 'sandbox', type: 'confidential' }],
            ['PATCH', `/api/v1/projects/${PA}/apps/${AA}`, { name: 'pwned', redirect_uris: ['https://evil.test/cb'] }],
            ['DELETE', `/api/v1/projects/${PA}/apps/${AA}`],
            ['POST', `/api/v1/projects/${PA}/apps/${AA}/credentials/rotate`, {}],
            ['POST', `/api/v1/projects/${PA}/apps/${AA}/credentials/${dev.PA.credential}/revoke`, {}],
            ['POST', `/api/v1/projects/${PA}/apps/${AA}/grants`, { capability: 'identity.subject.resolve' }],
            ['POST', `/api/v1/projects/${PA}/apps/${AA}/grants/media.object.upload/approve`, {}],
            ['POST', `/api/v1/projects/${PA}/apps/${AA}/grants/media.object.upload/deny`, {}],
            ['DELETE', `/api/v1/projects/${PA}/apps/${AA}/grants/media.object.upload`],
            ['PUT', `/api/v1/projects/${PA}/quotas/media.object.upload`, { limit: 1, window: 'day' }],
            ['DELETE', `/api/v1/projects/${PA}/quotas/media.object.upload`],
            ['POST', `/api/v1/projects/${PA}/export-tokens`, { audience: 'openvibe.media', env: 'sandbox' }],
            // alice's ids under bob's own project
            ['GET', `/api/v1/projects/${PB}/apps/${AA}`],
            ['GET', `/api/v1/projects/${PB}/apps/${AA}/credentials`],
            ['PATCH', `/api/v1/projects/${PB}/apps/${AA}`, { name: 'pwned' }],
            ['DELETE', `/api/v1/projects/${PB}/apps/${AA}`],
            ['POST', `/api/v1/projects/${PB}/apps/${AA}/credentials/rotate`, {}],
            ['POST', `/api/v1/projects/${PB}/apps/${AB}/credentials/${dev.PA.credential}/revoke`, {}],
            ['POST', `/api/v1/projects/${PB}/apps/${AA}/grants`, { capability: 'identity.subject.resolve' }],
            ['DELETE', `/api/v1/projects/${PB}/apps/${AA}/grants/media.object.upload`],
            ['PATCH', `/api/v1/projects/${PB}/members/${users.alice.subject}`, { role: 'viewer' }],
            ['DELETE', `/api/v1/projects/${PB}/members/${users.alice.subject}`],
        ];
        for (const [m, p, body] of devWrites) await expectRefused('bob', m, p, body, { tables: DEV_TABLES });
        // Reads of alice's project under either path: 404 for bob.
        for (const p of [`/api/v1/projects/${PA}`, `/api/v1/projects/${PA}/members`, `/api/v1/projects/${PA}/apps`, `/api/v1/projects/${PA}/apps/${AA}`, `/api/v1/projects/${PA}/apps/${AA}/credentials`,
            `/api/v1/projects/${PA}/apps/${AA}/grants`, `/api/v1/projects/${PA}/quotas`, `/api/v1/projects/${PA}/usage`, `/api/v1/projects/${PA}/audit`]) {
            await expectRefused('bob', 'GET', p, undefined, { codes: [404] });
        }
        // A token for bob's app cannot be had with alice's credential, nor alice's with bob's.
        for (const [cid, sec] of [[AB, dev.PA.secret2], [AA, dev.PB.secret]]) {
            const r = await w.call(null, 'POST', '/oauth/token', new URLSearchParams({ grant_type: 'client_credentials', client_id: cid, client_secret: sec, audience: 'openvibe.media' }));
            assert.strictEqual(r.status, 401, 'one app\'s secret is not another\'s');
        }
        // Rotation overlap: both of alice's secrets work for her app (the old one until it expires).
        for (const sec of [dev.PA.secret, dev.PA.secret2]) {
            const r = await w.call(null, 'POST', '/oauth/token', new URLSearchParams({ grant_type: 'client_credentials', client_id: AA, client_secret: sec, audience: 'openvibe.media' }));
            assert.strictEqual(r.status, 200, 'both overlapping secrets work');
        }

        // Positive controls: the same routes work for their owner (and staff where staff decides).
        await ok('alice', 'PATCH', `/api/v1/projects/${PA}`, { name: 'alice-private-project-renamed' });
        await ok('alice', 'POST', `/api/v1/projects/${PA}/members`, { username: 'carol', role: 'viewer' });
        await ok('alice', 'PATCH', `/api/v1/projects/${PA}/members/${users.carol.subject}`, { role: 'developer' });
        await ok('alice', 'PATCH', `/api/v1/projects/${PA}/apps/${AA}`, { name: 'alice-private-app-renamed' });
        await ok('alice', 'DELETE', `/api/v1/projects/${PA}/apps/${AA}/grants/media.object.upload`);
        await ok('alice', 'POST', `/api/v1/projects/${PA}/apps/${AA}/grants`, { capability: 'media.object.upload' });
        await ok('alice', 'POST', `/api/v1/projects/${PA}/export-tokens`, { audience: 'openvibe.media', env: 'sandbox' });
        await ok('staff', 'PUT', `/api/v1/projects/${PA}/quotas/media.object.upload`, { limit: 5, window: 'day' }, [200, 201, 400]);
        await ok('alice', 'POST', `/api/v1/projects/${PA}/apps/${AA}/credentials/${dev.PA.credential}/revoke`, {});
        await ok('bob', 'POST', `/api/v1/projects/${PB}/apps/${AB}/credentials/rotate`, {}, 201);
        await ok('alice', 'DELETE', `/api/v1/projects/${PA}/members/${users.carol.subject}`);
        assert.strictEqual((await db.prepare('SELECT name FROM dev_projects WHERE id = ?').get(PA)).name, 'alice-private-project-renamed');
        assert.ok((await db.prepare('SELECT revoked_at FROM dev_credentials WHERE id = ?').get(dev.PA.credential)).revoked_at, 'alice revoked her own credential');

        // ── Personal data: bob against alice's ids ───────────────────────
        const notif = await db.prepare('SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC').get(users.alice.id);
        const session = await db.prepare('SELECT id FROM user_sessions WHERE user_id = ? AND is_active = 1').get(users.alice.id);
        const hist = await db.prepare('SELECT id FROM user_history WHERE user_id = ?').get(users.alice.id);
        assert.ok(notif && session && hist, 'alice has a notification, a session and a history entry');
        const ALICE = {
            tables: ['notifications', 'user_sessions', 'user_history', 'users', 'user_modules', 'user_follows', 'user_blocks', 'push_subscriptions', 'linked_accounts'],
            where: {
                notifications: `WHERE user_id = ${users.alice.id}`, user_sessions: `WHERE user_id = ${users.alice.id}`, user_history: `WHERE user_id = ${users.alice.id}`,
                users: `WHERE id = ${users.alice.id}`, user_modules: `WHERE subject_id = '${users.alice.subject}'`, user_follows: `WHERE follower_subject = '${users.alice.subject}'`,
                user_blocks: `WHERE blocker_subject = '${users.alice.subject}'`, push_subscriptions: `WHERE user_id = ${users.alice.id}`, linked_accounts: `WHERE user_id = ${users.alice.id}`,
            },
        };
        // Column names differ between modules; fall back to the whole table when a guess is wrong.
        for (const t of ALICE.tables) { try { await db.prepare(`SELECT * FROM "${t}" ${ALICE.where[t]}`).all(); } catch { ALICE.where[t] = ''; } }
        const aliceBefore = await snap(ALICE.tables, ALICE.where);
        const personal = [
            ['POST', `/api/notifications/${notif.id}/read`, {}],
            ['POST', `/api/notifications/${notif.id}/dismiss`, {}],
            ['POST', '/api/notifications/read-batch', { ids: [notif.id] }],
            ['DELETE', `/api/auth/sessions/${session.id}`],
            ['DELETE', `/api/history/${hist.id}`],
            ['PUT', '/api/auth/profile', { id: users.alice.id, user_id: users.alice.id, username: 'alice', bio: 'bob-was-here' }],
            ['PUT', `/api/modules/ai.preferences?subject=${users.alice.subject}`, { subject: users.alice.subject, subject_id: users.alice.subject, data: { style: 'formal' } }],
            ['DELETE', `/api/modules/ai.preferences?subject=${users.alice.subject}`],
            ['DELETE', `/api/v1/me/follows/channel/${users.bob.subject}?follower=${users.alice.subject}`],
            ['DELETE', `/api/v1/me/blocks/${users.carol.subject}?blocker=${users.alice.subject}`],
            ['POST', '/api/push/unsubscribe', { endpoint: w.pushSub.endpoint, user_id: users.alice.id }],
            ['DELETE', `/api/notifications?user_id=${users.alice.id}`],
            ['DELETE', `/api/history?user_id=${users.alice.id}`],
        ];
        for (const [m, p, body] of personal) {
            const r = await w.call('bob', m, p, body, m === 'PUT' && p.startsWith('/api/modules') ? { 'if-match': '0' } : {});
            for (const l of crawler.leaks(r, secretNeedles)) refused.push(`${m} ${p}: carries ${l.label}`);
            if (await snap(ALICE.tables, ALICE.where) !== aliceBefore) { refused.push(`${m} ${p} as bob changed alice's data (${r.status})`); break; }
        }
        // Positive controls: alice can do each of these to her own data.
        await ok('alice', 'POST', `/api/notifications/${notif.id}/read`, {});
        assert.strictEqual((await db.prepare('SELECT is_read FROM notifications WHERE id = ?').get(notif.id)).is_read, 1);
        await ok('alice', 'DELETE', `/api/history/${hist.id}`);
        assert.ok(!await db.prepare('SELECT id FROM user_history WHERE id = ?').get(hist.id));
        await ok('alice', 'DELETE', `/api/auth/sessions/${session.id}`);
        assert.strictEqual((await db.prepare('SELECT is_active FROM user_sessions WHERE id = ?').get(session.id)).is_active, 0);
        await ok('bob', 'PUT', '/api/auth/profile', { id: users.alice.id, user_id: users.alice.id, username: 'alice', bio: 'bob-was-here' });
        assert.strictEqual((await db.prepare('SELECT bio FROM users WHERE id = ?').get(users.bob.id)).bio, 'bob-was-here', 'the ids in the body were ignored: bob edited his own profile');

        // ── Service principals outside their own app ───────────────────
        const live = { authorization: `Bearer ${w.liveToken}` };
        const media = { authorization: `Bearer ${await w.serviceToken('media')}` };
        const credit = (app) => ({ user_id: users.alice.id, app_id: app, amount: 5, reason: 'idor test', idempotency_key: `k-${app}-${Date.now()}` });
        const svcTables = { tables: ['notifications', 'wallets', 'coin_transactions', 'linked_accounts', 'user_modules', 'identity_legacy_map'] };
        await expectRefused(live, 'POST', '/internal/notifications/push', { user_id: users.alice.id, type: 'system', title: 'spoofed', message: 'x', service: 'games' }, svcTables);
        await expectRefused(live, 'POST', '/internal/coins/credit', credit('games'), svcTables);
        await expectRefused(live, 'POST', '/internal/link-account', { user_id: users.alice.id, service: 'games', service_user_id: 'spoof-1' }, svcTables);
        await expectRefused(live, 'PUT', `/internal/modules/ai.preferences/${users.alice.subject}`, { data: { style: 'formal' } }, svcTables);
        await expectRefused(media, 'POST', '/internal/identity/legacy-map', { entries: [{ network_user_id: users.alice.id, source_system: 'live', source_type: 'user', source_id: '4242' }] }, svcTables);
        await expectRefused(media, 'POST', '/internal/coins/credit', credit('media'), svcTables);   // no network.coins.credit
        // A developer app token is no service principal.
        await expectRefused({ authorization: `Bearer ${w.appToken}` }, 'POST', '/internal/notifications/push', { user_id: users.alice.id, title: 'x', message: 'x', service: 'live' }, svcTables);
        await expectRefused({ authorization: `Bearer ${w.appToken}` }, 'GET', `/internal/identity/resolve?user_id=${users.alice.id}`);
        // Positive controls: in their own name they may.
        await ok(live, 'POST', '/internal/notifications/push', { user_id: users.alice.id, type: 'system', category: 'system', title: 'fine', message: 'x', service: 'live' });
        await ok(live, 'POST', '/internal/coins/credit', credit('live'));
        await ok(live, 'POST', '/internal/link-account', { user_id: users.alice.id, service: 'live', service_user_id: 'alice-live-1' });
        await ok(live, 'PUT', `/internal/modules/live.profile/${users.alice.subject}`, { data: { followers: 3, is_streamer: false } });

        assert.deepStrictEqual(refused, [], `IDOR:\n${refused.join('\n')}`);
        out(`security idor: ${devWrites.length + personal.length + 8} swapped-id attempts refused, all checks passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } finally {
        await w.stop();
    }
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
