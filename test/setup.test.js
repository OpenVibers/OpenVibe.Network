'use strict';
// The owner's Setup tab (server/admin/setup.js; OWNER-SETUP-AND-ADMIN-CLARITY-DESIGN, 2026-11-07) against fake
// services: it lists every field carrying x-owner-input from every reachable service and Network's own to-dos,
// Needed first, with counts that add up; a secret entered through the proxy reaches the service and never Network's
// database or logs; Test shows the service's one-line answer and a failing test makes the row Not working until the
// key changes; a to-do is marked done in network.setup; a service without settings is named in plain words; and
// nobody but the owner gets the tab (no button for an admin, 403 from the API).
//   node test/setup.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { buildWorld } = require('./security-world');
const { checkSecretsStored } = require('./security-suite');

const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const NOW = new Date().toISOString();
const ROOT = path.join(__dirname, '..');

/** A fake service: records every request and answers from `routes` ({ 'METHOD /path': body | fn | [status, body] }). */
function fake(name) {
    const seen = [];
    const holder = { name, seen, routes: {} };
    holder.srv = http.createServer((req, res) => {
        let text = '';
        req.on('data', (d) => { text += d; });
        req.on('end', () => {
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch { body = text; }
            const rec = { method: req.method, url: req.url, headers: req.headers, body };
            seen.push(rec);
            const hit = holder.routes[`${req.method} ${req.url.split('?')[0]}`];
            let answer = typeof hit === 'function' ? hit(rec) : hit;
            let status = 200;
            if (Array.isArray(answer)) [status, answer] = answer;
            if (answer === undefined) { status = 404; answer = { code: 'config.route_not_found', error: 'no such route' }; }
            res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' });
            res.end(JSON.stringify(answer));
        });
    });
    return new Promise((resolve) => holder.srv.listen(0, '127.0.0.1', () => { holder.url = `http://127.0.0.1:${holder.srv.address().port}`; resolve(holder); }));
}

const fp = (v) => crypto.createHash('sha256').update(`fake|${v}`).digest('hex');
const marker = (v) => ({ redacted: true, fingerprint: fp(v) });

(async () => {
    const SECRET = 'setup-sentinel-bot-token-6c2e9a-never-stored';
    const SECRET2 = 'setup-sentinel-second-token-1b8f4d';
    const ai = await fake('ai');
    const chat = await fake('chat');
    const deals = await fake('deals');
    const unreachable = 'http://127.0.0.1:9';
    let w = null;
    try {
        w = await buildWorld({
            label: 'setup',
            env: {
                OV_AI_INTERNAL_URL: ai.url, OV_CHAT_INTERNAL_URL: chat.url, OV_DEALS_INTERNAL_URL: deals.url,
                OV_BILLING_INTERNAL_URL: unreachable, OV_SERVICES_INTERNAL_URL: unreachable, OV_WATCH_INTERNAL_URL: unreachable,
                OV_BENCH_INTERNAL_URL: unreachable, OV_REPORT_INTERNAL_URL: unreachable, OV_HOST_INTERNAL_URL: unreachable,
                OV_CODES_INTERNAL_URL: unreachable, OV_ACTOR_INTERNAL_URL: unreachable, OV_CONNECT_INTERNAL_URL: unreachable,
                OV_WORK_INTERNAL_URL: unreachable, OV_SOURCES_INTERNAL_URL: unreachable, OV_DESIGN_INTERNAL_URL: unreachable,
                OV_DOMAINS_INTERNAL_URL: unreachable, OV_MEDIA_INTERNAL_URL: unreachable,
            },
        });
        const owner = w.users.owner;
        const fresh = jwt.sign({ sub: owner.id, id: owner.id, username: owner.username, subject_id: owner.subject, role: owner.role, auth_time: Math.floor(Date.now() / 1000) },
            w.keys.privateKey, { algorithm: 'RS256', issuer: w.issuer, expiresIn: '1h' });
        const ownerCall = (method, p, body) => w.call({ authorization: `Bearer ${fresh}`, cookie: `ov_token=${fresh}` }, method, p, body);

        // ── What the fakes publish ──
        const LONG = 'A description long enough to say what it does and what the default means.';
        // Chat: a secret bot token (Needed until set, testable), a client id (internal, optional, set) and a field
        // without x-owner-input (never on Setup).
        const chatState = { token: null, revision: 3 };
        const chatSummary = () => ({
            service: 'chat', namespace: 'chat.apps', revision: chatState.revision, sealed: true, pins: [],
            values: { slack_client_id: '1234.5678', answer_mode: 'quiet', ...(chatState.token ? { telegram_bot_token: marker(chatState.token) } : {}) },
            classification: { slack_client_id: 'internal', answer_mode: 'internal', ...(chatState.token ? { telegram_bot_token: 'secret' } : {}) },
            schema: {
                title: 'Chat apps', description: 'The bot tokens the agent uses in chat apps.', type: 'object',
                properties: {
                    telegram_bot_token: { type: 'string', title: 'Telegram bot token', description: 'Lets agents answer in Telegram. Without it the Telegram option stays hidden.',
                        'x-owner-input': { group: 'chat-apps', unlocks: 'Lets agents answer in Telegram.', get_it_at: 'https://core.telegram.org/bots#how-do-i-create-a-bot', get_it_how: 'Ask @BotFather for /newbot and copy the token.', test: true },
                        'x-required-for': 'Agents in Telegram' },
                    slack_client_id: { type: 'string', title: 'Slack client id', description: LONG, 'x-owner-input': { group: 'sign-in-apps', unlocks: 'Lets people add the agent to Slack.' }, 'x-example': '1234.5678' },
                    answer_mode: { type: 'string', title: 'Answer mode', description: LONG, enum: ['quiet', 'chatty'] },
                },
            },
            active: null, last_known_good: null,
            kek: 'k1',
            secrets: chatState.token ? { telegram_bot_token: { redacted: true, fingerprint: fp(chatState.token), hint: chatState.token.slice(-4), set_at: NOW, set_by: { type: 'user', id: owner.subject }, bound_to: null } } : {},
        });
        Object.assign(chat.routes, {
            'GET /internal/config': () => ({ namespaces: [chatSummary()] }),
            'GET /internal/config/chat.apps': () => chatSummary(),
            'PUT /internal/config/chat.apps/secrets/telegram_bot_token': (rec) => { chatState.token = rec.body.value; chatState.revision += 1; return chatSummary().secrets.telegram_bot_token; },
            'DELETE /internal/config/chat.apps/secrets/telegram_bot_token': () => { chatState.token = null; chatState.revision += 1; return { redacted: true, fingerprint: null, hint: null, set_at: null, set_by: null, bound_to: null }; },
        });
        let chatTest = { ok: false, message: 'Telegram said 401 Unauthorized:\n the token was refused' };
        chat.routes['POST /internal/config/chat.apps/test/telegram_bot_token'] = () => chatTest;
        // AI: a GPU key (secret, Needed, unset) and a monthly cap (a money number, optional, unset).
        Object.assign(ai.routes, {
            'GET /internal/config': {
                namespaces: [{
                    service: 'ai', namespace: 'ai.gpus', revision: 2, sealed: true, pins: [], values: {}, classification: {},
                    schema: {
                        title: 'OpenVibe GPUs', type: 'object', properties: {
                            'vast.key': { type: 'string', title: 'Vast.ai API key', description: LONG, 'x-owner-input': { group: 'gpus', unlocks: 'Lets OpenVibe rent GPUs on Vast.ai.', get_it_at: 'https://cloud.vast.ai/account/', get_it_how: 'Create an API key with the instance permissions.' }, 'x-required-for': 'Renting GPUs' },
                            monthly_cap: { type: 'integer', title: 'Monthly GPU cap', description: LONG, 'x-unit': 'nano_usd', 'x-danger': true, 'x-owner-input': { group: 'gpus', unlocks: 'Caps what GPU rentals may cost in a month.' } },
                            region: { type: 'string', title: 'Region', description: LONG },
                        },
                    },
                    active: null, last_known_good: null,
                }],
            },
        });
        // Deals has not mounted the config routes yet.
        deals.routes['GET /internal/config'] = [404, { code: 'not_found', error: 'Not found' }];

        // ── Only the owner: a user and a plain admin get 403, and nothing reaches a service ──
        let r = await w.call('alice', 'GET', '/api/admin/setup');
        assert.strictEqual(r.status, 403, 'a user never gets Setup');
        r = await w.call('staff', 'GET', '/api/admin/setup');
        assert.strictEqual(r.status, 403, 'a plain admin never gets Setup');
        r = await w.call('staff', 'POST', '/api/admin/setup/tasks/dmca_agent', { done: true });
        assert.strictEqual(r.status, 403, 'a plain admin cannot mark a to-do');
        // Only config calls count: the server's own boot-time calls (navbar copy and the like) may reach a fake too.
        const configCalls = () => [...ai.seen, ...chat.seen, ...deals.seen].filter((x) => x.url.startsWith('/internal/config'));
        assert.strictEqual(configCalls().length, 0, 'a refused request never reaches a service');

        // ── The page: the Setup tab is the first button, owner only, and the tab is in the owner-only set ──
        const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
        const firstTab = html.slice(html.indexOf('id="main-tabs"')).match(/<button[^>]*>/)[0];
        assert.match(firstTab, /showTab\('setup',this\)/, 'Setup is the first tab');
        assert.match(firstTab, /owner-only/, 'the Setup button is hidden from anyone but the owner');
        assert.ok(html.includes('id="sec-setup"') && !html.includes('id="sec-glossary"'));
        const core = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'core.js'), 'utf8');
        assert.match(core.match(/const OWNER_ONLY_TABS = new Set\(\[[^\]]*\]\)/)[0], /'setup'/, 'a non-owner who opens /admin#setup is sent to the dashboard');

        // ── The checklist: every x-owner-input field and Network's own to-dos, Needed first, counts that add up ──
        r = await ownerCall('GET', '/api/admin/setup');
        assert.strictEqual(r.status, 200, r.text);
        const keys = r.body.rows.filter((x) => x.kind === 'key').map((x) => x.id).sort();
        assert.deepStrictEqual(keys, ['ai/ai.gpus/monthly_cap', 'ai/ai.gpus/vast.key', 'chat/chat.apps/slack_client_id', 'chat/chat.apps/telegram_bot_token'], 'every field with x-owner-input, and only those');
        const tasks = r.body.rows.filter((x) => x.kind === 'task').map((x) => x.key).sort();
        assert.deepStrictEqual(tasks, ['csam_scanning', 'dmca_agent', 'dnssec_records', 'ncmec_registration', 'provider_topup', 'public_suffix_list']);
        const rank = { needed: 0, not_working: 1, connected: 2, optional: 3 };
        r.body.rows.forEach((row, i) => { if (i) assert.ok(rank[r.body.rows[i - 1].state] <= rank[row.state], 'rows are Needed, Not working, Connected, Optional'); });
        assert.strictEqual(r.body.rows[0].state, 'needed', 'Needed sorts first');
        assert.strictEqual(r.body.groups[0].rows[0].state, 'needed', 'the page opens on a group with something that needs the owner');
        const c = r.body.counts;
        assert.strictEqual(c.needed + c.not_working + c.connected + c.optional, c.total, 'the counts add up');
        assert.strictEqual(c.total, r.body.rows.length);
        assert.strictEqual(r.body.groups.reduce((n, g) => n + g.rows.length, 0), c.total, 'every row is in one group');
        const row = (id) => r.body.rows.find((x) => x.id === id);
        let tg = row('chat/chat.apps/telegram_bot_token');
        assert.deepStrictEqual({ state: tg.state, required_for: tg.required_for, group: tg.group, secret: tg.secret, testable: tg.testable, set: tg.set, get_it_at: tg.get_it_at },
            { state: 'needed', required_for: 'Agents in Telegram', group: 'chat-apps', secret: true, testable: true, set: false, get_it_at: 'https://core.telegram.org/bots#how-do-i-create-a-bot' },
            'an unset token an older service leaves unclassified is still taken for a secret');
        assert.strictEqual(row('ai/ai.gpus/vast.key').secret, true, 'so is an unset key');
        assert.strictEqual(row('chat/chat.apps/slack_client_id').secret, false, 'a client id is not');
        assert.strictEqual(row('chat/chat.apps/slack_client_id').state, 'connected', 'a plain value that is set and never failed is Connected');
        assert.strictEqual(row('chat/chat.apps/slack_client_id').value, '1234.5678', 'a plain value is shown');
        assert.strictEqual(row('ai/ai.gpus/monthly_cap').state, 'optional', 'unset and nothing waits on it: Optional');
        assert.strictEqual(row('ai/ai.gpus/monthly_cap').unit, 'nano_usd');
        assert.strictEqual(row('ai/ai.gpus/vast.key').state, 'needed');
        assert.strictEqual(row(`network/network.setup/ncmec_registration`).state, 'needed', 'a legal to-do that something waits on is Needed');
        assert.strictEqual(row(`network/network.setup/dnssec_records`).state, 'optional');
        const dealsNote = r.body.services.find((s) => s.service === 'deals');
        assert.deepStrictEqual({ answered: dealsNote.answered, note: dealsNote.note }, { answered: false, note: 'OpenVibe.Deals has not published settings yet.' }, 'a service without the routes is named in plain words');
        assert.strictEqual(r.body.services.find((s) => s.service === 'media').note, 'OpenVibe.Media has not published settings yet.', 'one that does not answer too');
        assert.ok(r.body.empty_groups.some((g) => g.id === 'voices'), 'a group no service fills yet is listed as empty');

        // ── A secret entered on Setup: through the proxy to the service's vault, then Connected with its hint ──
        r = await ownerCall('PUT', '/api/admin/ai/config/chat/chat.apps/secrets/telegram_bot_token', { value: SECRET, reason: 'Entered on Setup' });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(!r.text.includes(SECRET), 'the answer is the marker, never the value');
        const put = chat.seen.filter((x) => x.method === 'PUT').at(-1);
        assert.strictEqual(put.body.value, SECRET, 'the service gets the value once');
        assert.strictEqual(put.headers['x-ov-fresh'], '1');
        r = await ownerCall('GET', '/api/admin/setup');
        tg = r.body.rows.find((x) => x.id === 'chat/chat.apps/telegram_bot_token');
        assert.deepStrictEqual({ state: tg.state, set: tg.set, secret: tg.secret, hint: tg.hint, last_test: tg.last_test }, { state: 'connected', set: true, secret: true, hint: SECRET.slice(-4), last_test: null });
        assert.ok(!r.text.includes(SECRET), 'Setup never shows the value');

        // ── Test: the service's one-line answer; a failure makes the row Not working ──
        r = await ownerCall('POST', '/api/admin/ai/config/chat/chat.apps/test/telegram_bot_token', {});
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual({ passed: r.body.passed, message: r.body.message }, { passed: false, message: 'Telegram said 401 Unauthorized: the token was refused' });
        r = await ownerCall('GET', '/api/admin/setup');
        tg = r.body.rows.find((x) => x.id === 'chat/chat.apps/telegram_bot_token');
        assert.strictEqual(tg.state, 'not_working', 'a failed test is Not working');
        assert.strictEqual(tg.last_test.message, 'Telegram said 401 Unauthorized: the token was refused', 'with the provider\'s answer in one line');
        assert.strictEqual(r.body.counts.not_working, 1);
        assert.strictEqual(r.body.rows.find((x) => x.state !== 'needed').id, 'chat/chat.apps/telegram_bot_token', 'Not working comes right after Needed');

        // A new key: the old failure no longer counts.
        r = await ownerCall('PUT', '/api/admin/ai/config/chat/chat.apps/secrets/telegram_bot_token', { value: SECRET2, reason: 'Replaced on Setup' });
        assert.strictEqual(r.status, 200, r.text);
        r = await ownerCall('GET', '/api/admin/setup');
        tg = r.body.rows.find((x) => x.id === 'chat/chat.apps/telegram_bot_token');
        assert.deepStrictEqual({ state: tg.state, last_test: tg.last_test }, { state: 'connected', last_test: null }, 'a replaced key is not judged by the old key\'s test');
        chatTest = { ok: true, message: 'Telegram knows the bot @openvibe_bot.' };
        r = await ownerCall('POST', '/api/admin/ai/config/chat/chat.apps/test/telegram_bot_token', {});
        assert.deepStrictEqual({ passed: r.body.passed, message: r.body.message }, { passed: true, message: 'Telegram knows the bot @openvibe_bot.' });
        r = await ownerCall('GET', '/api/admin/setup');
        tg = r.body.rows.find((x) => x.id === 'chat/chat.apps/telegram_bot_token');
        assert.deepStrictEqual({ state: tg.state, passed: tg.last_test.passed }, { state: 'connected', passed: true });

        // ── Network's own to-dos: Mark done, kept in network.setup, and undone ──
        r = await ownerCall('POST', '/api/admin/setup/tasks/ncmec_registration', { done: true });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.row.state, 'connected');
        assert.strictEqual(r.body.row.done.by, owner.username);
        r = await ownerCall('GET', '/api/admin/setup');
        assert.strictEqual(r.body.rows.find((x) => x.key === 'ncmec_registration').state, 'connected', 'a to-do marked done stays done');
        const snap = await w.db.prepare("SELECT values_json, created_by FROM config_snapshots WHERE namespace = 'network.setup' AND state = 'active'").get();
        assert.ok(JSON.parse(snap.values_json).ncmec_registration.done_at, 'it is a revision of network.setup');
        assert.match(String(snap.created_by), new RegExp(owner.subject), 'made by the owner');
        r = await ownerCall('POST', '/api/admin/setup/tasks/ncmec_registration', { done: false });
        assert.strictEqual(r.body.row.state, 'needed', 'and it can be undone');
        r = await ownerCall('POST', '/api/admin/setup/tasks/no_such_thing', { done: true });
        assert.strictEqual(r.status, 404);
        r = await ownerCall('POST', '/api/admin/setup/tasks/dmca_agent', { done: 'yes' });
        assert.strictEqual(r.status, 400);

        // ── Network's own namespace reads clearly (lintSchema, openvibe-shared 4.125.0) ──
        const sharedConfig = require('openvibe-shared/config');
        const { TASKS_SCHEMA } = require('../server/admin/setup');
        if (typeof sharedConfig.lintSchema === 'function') assert.deepStrictEqual(sharedConfig.lintSchema(TASKS_SCHEMA), [], 'every to-do has a title and a clear description');
        else for (const [k, p] of Object.entries(TASKS_SCHEMA.properties)) assert.ok(p.title && p.description.length >= 30, `${k} reads clearly`);

        // ── No secret in a Network table or log line ──
        await checkSecretsStored(w, () => ({ 'setup secret': SECRET, 'setup second secret': SECRET2 }));

        out('setup: all checks passed');
    } finally {
        if (w) await w.stop();
        for (const f of [ai, chat, deals]) await new Promise((res) => f.srv.close(res));
    }
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
