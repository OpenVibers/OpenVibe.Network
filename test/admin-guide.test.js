'use strict';
// The owner's guided setup (/admin/guide, 2026-11-12): the rules that turn the live state into ordered steps with the
// setting we recommend (public/js/admin/guide-rules.js), and the route that keeps what the owner skipped or saw
// (server/admin/guide.js): owner only, step ids only, kept in network.guide. The admin page wires the tab, the
// section, the scripts and a call to action at the top of Setup.
//   node test/admin-guide.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { buildWorld } = require('./security-world');
const rules = require('../public/js/admin/guide-rules.js');

const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const ROOT = path.join(__dirname, '..');

// ── The rules ──
{
    // ov-node-01 as it was on 11-12: a shared desk host with two models and the Codes runner, everything off.
    const node = {
        id: 'dev_N', name: 'ov-node-01', kind: 'onboard', roles: [], principal_id: 'lnk_N',
        fleet: [{ agent: 'codex', installed: true, signed_in: false }],
        controls: { computer: true, level: 'trusted', probe: true, agent_computer: false, watch_probe: false, ai_models: false, shared_desks: false,
            desk: { available: true, sandboxed: true, max: 7 }, ai: { available: true, models: 2, offered: true } },
    };
    const rec = rules.recommendMachine(node);
    assert.deepStrictEqual(rec.roles, ['codes.worker', 'desks.host', 'ai.host'], 'a role for each thing it can do');
    assert.deepStrictEqual(rec.switches, { ai_models: true, agent_computer: true, watch_probe: true, shared_desks: true });
    assert.ok(rec.why.some((w) => /locked in its own box/.test(w)), 'says why it may lend browsers');

    // A laptop: no sandbox, no models, no runner: only what it has; a robot role that is on is kept.
    const laptop = { id: 'dev_L', name: 'Laptop', roles: ['bot.robot'], controls: { computer: true, level: 'ask', probe: false, desk: { available: true, sandboxed: false } } };
    assert.deepStrictEqual(rules.recommendMachine(laptop).roles, ['desks.host', 'bot.robot']);
    assert.strictEqual(rules.recommendMachine(laptop).switches.shared_desks, undefined, 'never lends browsers that are not each in a box');
    assert.strictEqual(rules.machineChange({ ...node, roles: rec.roles, controls: { ...node.controls, ...rec.switches } }), null, 'nothing to change once it matches');

    // Caps: twice the last 30 days, at least $5, in steps of $5.
    assert.strictEqual(rules.capFor({ estimated_month_usd: 0 }), 5);
    assert.strictEqual(rules.capFor({ estimated_month_usd: 3.2 }), 10);
    assert.strictEqual(rules.capFor({ estimated_month_usd: 12, month_usd: 14 }), 30);

    // Keys: the provider that unlocks the most jobs first.
    const ai = { steps: [
        { id: 'chat', name: 'Chat and writing', short: 'Chat', route: 'default.chat', ready: false, recommended: { provider: 'deepseek', configured: false }, key_page: 'https://platform.deepseek.com' },
        { id: 'code', name: 'Code agents', short: 'Code', route: 'space.build', ready: false, recommended: { provider: 'deepseek', configured: false } },
        { id: 'image', name: 'Images', short: 'Images', route: 'default.image', ready: false, recommended: { provider: 'together', configured: false } },
        { id: 'stt', name: 'Speech to text', short: 'Speech in', route: 'live.stt', ready: false, current: null, recommended: { provider: 'groq', configured: true, label: 'Whisper large v3' }, estimated_month_usd: 3.2, cap_usd: null },
        { id: 'decide', name: 'Decisions', short: 'Decisions', route: 'decide.fallback', ready: false, current: 'deepseek/flash', recommended: { provider: 'gemini', configured: false }, cap_usd: 5 },
    ] };
    assert.deepStrictEqual(rules.keysWanted(ai).map((k) => [k.provider, k.jobs.length]), [['deepseek', 2], ['gemini', 1], ['together', 1]]);

    const setup = {
        services: [{ service: 'ai', name: 'OpenVibe.AI', answered: true }, { service: 'chat', name: 'OpenVibe.Chat', answered: false }],
        groups: [
            { id: 'ai-providers', label: 'AI providers', rows: [{ state: 'needed', title: 'DeepSeek key', service_name: 'OpenVibe.AI' }] },
            { id: 'money', label: 'Money', rows: [{ state: 'needed', title: 'Stripe key', service_name: 'OpenVibe.Billing', required_for: 'checkout' }] },
            { id: 'voices', label: 'Voices', rows: [{ state: 'optional', title: 'Polly key', service_name: 'OpenVibe.Live', unlocks: 'more voices' }] },
            { id: 'domains', label: 'Domains', rows: [{ state: 'connected', title: 'Cloudflare token', service_name: 'OpenVibe.Domains' }] },
        ],
    };
    const g = rules.build({ setup, ai, machines: [node], access: { lnk_N: { others_may_ask: false, auto_agent_send: true, agents_talk: false } }, progress: { seen: ['welcome'], skipped: ['credits'] } });
    const by = Object.fromEntries(g.steps.map((s) => [s.id, s]));
    assert.deepStrictEqual(g.steps.map((s) => s.id), ['welcome', 'services', 'ai-keys', 'ai-models', 'ai-caps', 'decisions', 'credits', 'machines', 'shared', 'coding', 'agents', 'keys-money', 'keys-voices', 'keys-domains', 'finish'],
        'in order: start, AI, computers, coding, agents, every other group (AI providers are the AI steps), finish');
    assert.strictEqual(by.services.state, 'needs_you');
    assert.match(by['ai-keys'].recommended.label, /deepseek/i);
    assert.deepStrictEqual(by['ai-models'].recommended.apply, { type: 'ai-recommended' }, 'a job whose key is in gets the recommended model');
    assert.deepStrictEqual(by['ai-caps'].recommended.apply, { type: 'ai-caps', caps: { chat: 5, code: 5, image: 5, stt: 10 } }, 'a cap for each routed job without one');
    assert.strictEqual(by.decisions.recommended.apply.type, 'ai-test', 'Decisions has a route: test it');
    assert.strictEqual(by.credits.state, 'skipped');
    assert.strictEqual(by.machines.recommended.apply.changes[0].id, 'dev_N');
    assert.deepStrictEqual(by.machines.recommended.apply.changes[0].roles, ['codes.worker', 'desks.host', 'ai.host']);
    assert.match(by.machines.items[0].text, /ov-node-01: run your coding tasks, give your agents a browser, serve its AI models, let OpenVibe AI use its models/);
    assert.deepStrictEqual(by.shared.recommended.apply.changes[0].settings, { others_may_ask: true, agents_talk: true }, 'a shared node opens to others');
    assert.strictEqual(by.coding.state, 'todo', 'the Codes runner is there but the role is not on yet');
    assert.strictEqual(by['keys-money'].state, 'needs_you');
    assert.strictEqual(by['keys-voices'].state, 'optional');
    assert.strictEqual(by['keys-domains'].state, 'done');
    assert.strictEqual(g.next, 'services', 'the first step that wants you');
    assert.match(by.finish.title, /What is left/);

    // Nothing read (a service down): every step that depends on it says so instead of guessing.
    const blind = rules.build({});
    assert.ok(['services', 'ai-keys', 'machines', 'coding'].every((id) => blind.steps.find((s) => s.id === id).state === 'unknown'));
    // Nothing paired: the machines step asks for a computer.
    assert.strictEqual(rules.build({ machines: [] }).steps.find((s) => s.id === 'machines').state, 'needs_you');
    out('guide rules: computers from what they can do, caps from spend, keys by reach, ordered steps, skipped and unknown');
}

// ── The page is wired ──
{
    const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
    assert.ok(html.includes("showTab('guide',this)") && html.includes('id="sec-guide"') && html.includes('/js/admin/guide-rules.js') && html.includes('/js/admin/guide.js') && html.includes('/css/guide.css'));
    assert.ok(html.includes('href="/admin/guide">Start the guided setup</a>'), 'Setup points to it');
    assert.ok(/OWNER_ONLY_TABS = new Set\(\['guide',/.test(fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'core.js'), 'utf8')), 'owner only');
    assert.ok(/guide: loadGuide/.test(fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'boot.js'), 'utf8')));
    const page = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'guide.js'), 'utf8');
    assert.ok(!/innerHTML/.test(page), 'built from DOM nodes');
    for (const route of ['/api/admin/ai/setup/recommended', '/api/admin/ai/setup/caps/', '/roles', '/access-settings']) assert.ok(page.includes(route), `applies through ${route}`);
    out('guide page: tab, section, scripts, owner only, the Setup call to action, applied through the existing routes');
}

// ── The route ──
(async () => {
    let w = null;
    try {
        // Every service unreachable, as in test/setup.test.js: the guide's route reads none of them.
        const unreachable = 'http://127.0.0.1:9';
        const env = Object.fromEntries(['AI', 'CHAT', 'DEALS', 'BILLING', 'SERVICES', 'WATCH', 'BENCH', 'REPORT', 'HOST', 'CODES', 'ACTOR', 'CONNECT', 'WORK', 'SOURCES', 'DESIGN', 'DOMAINS', 'MEDIA']
            .map((s) => [`OV_${s}_INTERNAL_URL`, unreachable]));
        w = await buildWorld({ label: 'guide', env });
        const owner = w.users.owner;
        const fresh = jwt.sign({ sub: owner.id, id: owner.id, username: owner.username, subject_id: owner.subject, role: owner.role, auth_time: Math.floor(Date.now() / 1000) },
            w.keys.privateKey, { algorithm: 'RS256', issuer: w.issuer, expiresIn: '1h' });
        const ownerCall = (method, p, body) => w.call({ authorization: `Bearer ${fresh}`, cookie: `ov_token=${fresh}` }, method, p, body);

        let r = await w.call('alice', 'GET', '/api/admin/guide');
        assert.strictEqual(r.status, 403, 'a user never gets the guide');
        r = await w.call('staff', 'PUT', '/api/admin/guide', { skipped: ['credits'] });
        assert.strictEqual(r.status, 403, 'a plain admin cannot change it');
        r = await ownerCall('GET', '/api/admin/guide');
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual([r.body.skipped, r.body.seen], [[], []]);
        r = await ownerCall('PUT', '/api/admin/guide', { skipped: ['credits', 'credits', 'Not A Step!'], seen: ['welcome', 'ai-keys'] });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual([r.body.skipped, r.body.seen], [['credits'], ['welcome', 'ai-keys']], 'step ids only, once each');
        r = await ownerCall('PUT', '/api/admin/guide', { skipped: 'credits' });
        assert.strictEqual(r.status, 400, 'a list, not a string');
        r = await ownerCall('PUT', '/api/admin/guide', {});
        assert.strictEqual(r.status, 400, 'something to save');
        r = await ownerCall('GET', '/api/admin/guide');
        assert.deepStrictEqual(r.body.skipped, ['credits'], 'kept');
        const snap = await w.db.prepare("SELECT values_json FROM config_snapshots WHERE namespace = 'network.guide' AND state = 'active'").get();
        assert.ok(snap && JSON.parse(snap.values_json).seen.includes('ai-keys'), 'in network.guide, a revision like any setting');
        out('guide route: owner only, step ids only, kept in network.guide');
    } finally {
        if (w) await w.stop();
    }
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
