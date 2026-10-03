'use strict';
// Shared fixtures and route expansion for the module-scoped security checks.
const assert = require('assert');
const { buildWorld } = require('./security-world');
const crawler = require('./security-crawl');

const out = (...a) => process.stdout.write(a.join(' ') + '\n');

async function withWorld(label, check) {
    const t0 = Date.now();
    const w = await buildWorld({ label });
    try {
        await check(w);
        out(`security ${label}: all checks passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    } finally {
        await w.stop();
    }
}

async function prepareClosedIncident(w) {
    const inc = await w.call('staff', 'POST', '/api/v1/status/incidents', { kind: 'incident', title: 'long-closed-incident-title', severity: 'minor', state: 'investigating', services: ['network'], message: 'x' });
    assert.strictEqual(inc.status, 201, inc.text);
    const closed = await w.call('staff', 'POST', `/api/v1/status/incidents/${inc.body.id}/updates`, { state: 'resolved', message: 'fixed' });
    assert.strictEqual(closed.status, 200, closed.text);
    const longAgo = new Date(Date.now() - 40 * 864e5).toISOString();
    await w.db.prepare('UPDATE status_incidents SET starts_at = ?, updated_at = ?, ends_at = ? WHERE id = ?').run(longAgo, longAgo, longAgo, inc.body.id);
    await w.db.prepare('UPDATE status_incident_updates SET at = ? WHERE incident_id = ?').run(longAgo, inc.body.id);
}

function privateValues(w, name) {
    const { users, dev } = w;
    return ({
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
    })[name] || ['1'];
}

function privateArea(path) {
    if (path.startsWith('/api/v1/projects')) return 'projects';
    if (path.match(/^\/api\/(auth|notifications|history|modules|coins|push|v1\/me|v1\/follows|v1\/status)(\/|\?|$)/)) return 'personal';
    return 'platform';
}

async function privateCrawl(w, area) {
    const { users, dev } = w;
    await prepareClosedIncident(w);
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
    const allPaths = crawler.pathsFor(w.routes, (name) => privateValues(w, name), { method: 'get', query: 'all=1&limit=100&user_id=' + users.alice.id + '&subject=' + users.alice.subject, extra: ['/api/v1/projects?all=1', '/api/v1/status/incidents'] });
    const paths = allPaths.filter((p) => privateArea(p) === area);
    const people = { anonymous: w.callers.anonymous, user: w.callers.user, app: w.callers.app, service: w.callers.service };
    assert.ok(people.app && people.app.authorization, 'a developer app token to crawl with');
    const needlesFor = (who) => {
        const n = { ...alice };
        if (who === 'user') { delete n['bob project']; delete n['bob app']; }
        return n;
    };
    const res = await crawler.crawl(w.srv.base, paths, people, needlesFor);
    out(`private ${area} crawl: ${paths.length} paths x ${Object.keys(people).length} callers, ${JSON.stringify(res.statuses)}`);
    assert.deepStrictEqual(res.found, [], `private data reached the wrong caller:\n${res.found.join('\n')}`);
    assert.ok(res.answered === paths.length * Object.keys(people).length && (res.statuses['2xx'] || 0) > (area === 'platform' ? 200 : 0));
    return { res, people };
}

async function privateMine(w, who, p, needle) {
    const r = await w.call(who, 'GET', p);
    assert.ok(r.text.includes(needle), `${who} sees ${needle} at ${p} (${r.status})`);
}

function checkPrivateStatuses(w, res) {
    const st = res.byPath;
    const bad = [];
    for (const [k, s] of Object.entries(st)) {
        const [who, , p] = k.split(' ');
        const path = p.split('?')[0];
        if (who === 'service') continue;
        if (/^\/internal\//.test(path) && s < 400) bad.push(`${k} → ${s}`);
        if (/^\/api\/(admin|v1\/staff)\//.test(path) && path !== '/api/v1/staff/capabilities' && s < 400) bad.push(`${k} → ${s}`);
        if (path.startsWith(`/api/v1/projects/${w.dev.PA.id}`)) {
            const want = who === 'anonymous' || who === 'app' ? [401] : [404];
            if (!want.includes(s)) bad.push(`${k} → ${s} (want ${want})`);
        }
        if (/^\/api\/(notifications|history|modules|coins\/me|push\/status|auth\/sessions|auth\/me|v1\/me\/)/.test(path) && !/^\/api\/modules\/[^/]+\/public\//.test(path) && who !== 'user' && s < 400) bad.push(`${k} → ${s}`);
    }
    assert.deepStrictEqual(bad, [], `private reads answered:\n${bad.join('\n')}`);
}

function secretsValues(w, name) {
    const { users, dev } = w;
    return ({
        project: [dev.PA.id, dev.PB.id, 'prj_00000000000000000000000000', '..%2f'],
        app: [dev.PA.app, dev.PB.app, 'app_00000000000000000000000000', 'x'],
        credential: [dev.PA.credential, dev.PB.credential, 'crd_x'],
        capability: ['media.object.upload', 'identity.subject.resolve', 'x'],
        subject: [users.alice.subject, users.bob.subject, 'usr_x'],
        target: [users.alice.subject, users.bob.subject, 'x'],
        type: ['user', 'channel', 'x'],
        creator: [users.alice.subject, 'alice', 'x'],
        id: [String(users.alice.id), String(users.owner.id), '1', '999999', 'x', '-1'],
        userId: [String(users.alice.id), String(users.bob.id), '999999'],
        username: ['alice', 'rootowner', 'nobody'],
        name: ['alice', 'live', 'network', 'nobody'],
        ns: ['ai.preferences', 'chat.tts_defaults', 'live.profile', 'x'],
        namespace: ['general', 'network', 'x'],
        key: ['DEPLOY_CLOUDFLARE_TOKEN', 'OV_LIVE_URL', 'x'],
        token: ['not-a-token', 'x'],
        idOrSlug: ['default', 'x'],
        serviceId: ['live', 'network', 'x'],
        domain: ['openvibe.live', 'x'],
        topic: ['live.stream.started', 'x'],
        category: ['system', 'x'],
    })[name] || ['1', 'x'];
}

function secretsPeople(w) { return { ...w.callers, key: { 'x-internal-key': 'retired-key' } }; }

function secretsNeedlesFor(w, people) {
    const tokenOf = (h) => String((h && h.authorization) || '').replace(/^Bearer /, '');
    return (who) => {
        const n = { ...w.secrets };
        for (const [other, h] of Object.entries(people)) if (other !== who && tokenOf(h)) n[`${other}'s bearer token`] = tokenOf(h);
        if (who !== 'admin' && who !== 'owner') n['verification key'] = w.verificationKey;
        return n;
    };
}

function secretsPaths(w) {
    const extra = ['/api/nope', '/internal/nope', '/INTERNAL/users/1', '/.env', '/.git/config', '/package.json', '/server/config.js',
        '/data/network.db', '/data/keys/private.pem', '/keys/private.pem', '/private.pem', '/network.db', '/data/avatars/..%2fnetwork.db',
        '/data/avatars/%2e%2e/network.db', '/shared/..%2f..%2fpackage.json', '/node_modules/.package-lock.json', '/api/.well-known/jwks',
        '/.well-known/openid-configuration', '/oauth/.well-known/openid-configuration', '/api/ready', '/metrics', '/release.json', '/status',
        '/api/v1/status', '/api/admin/secrets', '/api/admin/settings', '/api/admin/config', '/api/admin/url-registry', '/api/admin/email',
        '/api/admin/discord/', '/api/admin/integrations/github/', '/api/admin/deploy/config', '/internal/url-registry/resolved',
        '/internal/integrations/github-token', '/api/setup/status', '/oauth/authorize?client_id=live&redirect_uri=https%3A%2F%2Fevil.test%2F&response_type=code',
        '/oauth/client-info?client_id=live', `/oauth/client-info?client_id=${w.dev.PA.app}`, '/api/auth/anon-identities', '/sso/check', '/fedcm/accounts'];
    return crawler.pathsFor(w.routes, (name) => secretsValues(w, name), { method: 'get', query: 'limit=5&all=1&debug=1&include=secret', extra });
}

async function checkSecretsStored(w, needlesFor) {
    const all = { ...needlesFor('nobody'), 'verification key': w.verificationKey };
    delete all['verification key'];   // stored in its own table by design; only its readers are checked above
    const logHits = crawler.leaks({ text: w.srv.logs(), headers: {} }, all).map((l) => l.label);
    assert.deepStrictEqual(logHits, [], 'nothing secret was logged');
    const tables = (await w.db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND (table_name LIKE '%outbox%' OR table_name LIKE '%audit%' OR table_name LIKE '%log%' OR table_name LIKE '%usage%' OR table_name LIKE '%changes%' OR table_name LIKE '%alerts%' OR table_name LIKE '%revisions%' OR table_name = 'notifications')").all()).map((r) => r.name);
    assert.ok(tables.includes('network_event_outbox') && tables.includes('dev_audit') && tables.includes('audit_log'), tables.join(','));
    const rowHits = [];
    for (const t of tables) {
        const text = JSON.stringify(await w.db.prepare(`SELECT * FROM "${t}"`).all());
        for (const l of crawler.leaks({ text, headers: {} }, all)) rowHits.push(`${t}: ${l.label}`);
    }
    assert.deepStrictEqual(rowHits, [], 'no secret in the outbox, audit or log tables');
    assert.ok((await w.db.prepare('SELECT COUNT(*) AS n FROM network_event_outbox').get()).n > 0, 'the outbox was written meanwhile');
}

module.exports = { withWorld, out, privateCrawl, privateMine, checkPrivateStatuses, secretsValues, secretsPeople, secretsNeedlesFor, secretsPaths, checkSecretsStored };
