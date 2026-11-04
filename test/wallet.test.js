'use strict';
// The wallet (MONEY.md D12): the page's money words, the activity mapping, and Network's proxies to Billing.
//
// - money: nano-USD and whole Vibes are integer end to end; the browser's formatter never starts from a float.
// - activity: one list over both currencies, only the person's own accounts, never creator payable or sandbox.
// - proxies: the person's own token goes to Billing's /api/me routes; the journal read uses Network's service token;
//   a charge id is checked before it is put in a URL; a write needs the bearer token (no cookie-only CSRF).
// - the pages: a static pay sheet with no form, three wallet cards, both themes, no spinner, no sideways width.
//   node --import ./test/helpers/pg-preload.mjs test/wallet.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { getDb } = require('../server/db/database');
const createWalletRoutes = require('../server/wallet/routes');
const principals = require('../server/identity/principals');
const money = require('../public/js/wallet/money');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0ABCD';
const VCH = 'vch_01JAB2C3D4E5F6G7H8J9K0ABCD';
const KEY = (n) => `idem-${String(n).padStart(4, '0')}`;

(async () => {
    // ── Money words ─────────────────────────────────────────
    assert.strictEqual(money.money('12400000000'), '$12.40');
    assert.strictEqual(money.money('0'), '$0.00');
    assert.strictEqual(money.money('4200000'), '$0.0042', 'below a cent, to the nano');
    assert.strictEqual(money.money('-4200000'), '−$0.0042');
    assert.deepStrictEqual(money.signedMoney('-4200000'), { sign: '−', text: '$0.0042' });
    assert.deepStrictEqual(money.signedMoney('2500000000'), { sign: '+', text: '$2.50' });
    assert.strictEqual(money.dollarsToNano('12.40'), '12400000000');
    assert.strictEqual(money.dollarsToNano('$1,000'), '1000000000000');
    assert.strictEqual(money.dollarsToNano('0.000000001'), '1', 'a nano is the smallest unit');
    assert.strictEqual(money.dollarsToNano('12.1234567890'), null, 'a tenth decimal is not money');
    assert.strictEqual(money.dollarsToNano('abc'), null);
    assert.strictEqual(money.dollarsToNano(''), null);
    assert.strictEqual(money.priceNano(1000, 100), '10000000000', '1,000 Vibes at 100 per USD is $10');
    assert.strictEqual(money.priceNano(1, 100), '10000000', 'rounded up to one cent, never down');
    assert.strictEqual(money.priceNano(0, 100), null);
    assert.strictEqual(money.whole('1,250'), 1250);
    assert.strictEqual(money.whole('1.5'), null);
    assert.strictEqual(money.vibes(1250), '1,250');

    // ── Activity mapping: one person, two currencies, no one else's money ──
    const subject = 'usr_01JAB2C3D4E5F6G7H8J9K0ABCD';
    const activity = createWalletRoutes.mapActivity(subject, [
        {
            id: 'txn_buy', type: 'purchase', created_at: '2026-11-04T10:00:00.000Z', metadata: { balance: 'vibes_from_balance', vibes: 500 },
            entries: [
                { account: { kind: 'usd_credit', owner: `user:${subject}`, currency: 'nano-usd' }, amount: '-5000000000' },
                { account: { kind: 'user_credit', owner: subject, currency: 'vibes-bits' }, amount: 500 },
                { account: { kind: 'platform_revenue', owner: null, currency: 'nano-usd' }, amount: '5000000000' },
            ],
        },
        {
            id: 'txn_ai', type: 'credit', created_at: '2026-11-03T09:00:00.000Z', metadata: { credit: 'settle', model: 'openvibe/auto' },
            entries: [
                { account: { kind: 'usd_credit', owner: `user:${subject}`, currency: 'nano-usd' }, amount: '-123000000' },
                { account: { kind: 'platform_revenue', owner: null, currency: 'nano-usd' }, amount: '123000000' },
            ],
        },
        {
            id: 'txn_payable', type: 'donation', created_at: '2026-11-02T09:00:00.000Z', metadata: {},
            entries: [
                { account: { kind: 'creator_payable', owner: subject, currency: 'vibes-bits' }, amount: 40 },
                { account: { kind: 'user_credit', owner: 'usr_OTHER', currency: 'vibes-bits' }, amount: -40 },
            ],
        },
        {
            id: 'txn_sandbox', type: 'credit', created_at: '2026-11-01T09:00:00.000Z', metadata: { credit: 'sandbox_grant' },
            entries: [{ account: { kind: 'usd_credit_sandbox', owner: `user:${subject}`, currency: 'nano-usd' }, amount: '999' }],
        },
    ]);
    assert.deepStrictEqual(activity.map((r) => [r.kinds, r.parts, r.label]), [
        [['balance', 'vibes'], [{ kind: 'balance', amount: '-5000000000' }, { kind: 'vibes', amount: 500 }], 'Got 500 Vibes with your Balance'],
        [['balance'], [{ kind: 'balance', amount: '-123000000' }], 'AI usage'],
    ], 'one row per transaction, both currencies together; creator payable and sandbox are not the spendable wallet');
    assert.strictEqual(createWalletRoutes.mapActivity(subject, null).length, 0);
    assert.deepStrictEqual(createWalletRoutes.mapPersonActivity(subject, { activity: [
        { id: 'txn_one', at: '2026-11-04T10:00:00.000Z', kind: 'vibes', label: 'Got 500 Vibes with your Balance', amount: 500 },
        { id: 'txn_one', at: '2026-11-04T10:00:00.000Z', kind: 'balance', label: 'Got 500 Vibes with your Balance', amount: '-5000000000' },
    ] }).map((r) => [r.kinds, r.parts]), [[['balance', 'vibes'], [{ kind: 'balance', amount: '-5000000000' }, { kind: 'vibes', amount: 500 }]]], 'the person-shaped route is grouped too');
    assert.deepStrictEqual(createWalletRoutes.mapPersonActivity(subject, { activity: [
        { id: 'txn_two', at: '2026-11-04T11:00:00.000Z', label: 'Got 10 Vibes with your Balance', amounts: { balance: '-100000000', vibes: 10 } },
    ] }).map((r) => [r.kinds, r.parts]), [[['balance', 'vibes'], [{ kind: 'balance', amount: '-100000000' }, { kind: 'vibes', amount: 10 }]]], 'an { amounts } shape is read too');
    assert.ok(!principals.DEFAULT_GRANTS.some(([client, cap]) => client === 'network' && cap === 'billing.balance.read'), 'Network does not seed a broad Billing read');

    // ── The proxies, against a stand-in Billing ─────────────
    const db = getDb();
    await db.prepare("INSERT INTO users (username, email, password_hash, role) VALUES ('walletuser', 'wallet@example.test', 'x', 'user') ON CONFLICT DO NOTHING").run();
    const user = await db.prepare("SELECT * FROM users WHERE username = 'walletuser'").get();
    await db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 340) ON CONFLICT (user_id) DO UPDATE SET balance = 340').run(user.id);
    await db.prepare(`INSERT INTO dev_projects (id, owner_subject, name, created_at, created_by)
        VALUES (?, ?, 'Wallet Project', ?::timestamptz, 'test') ON CONFLICT (id) DO NOTHING`).run(PRJ, subject, new Date().toISOString());
    const APP = 'app_01JAB2C3D4E5F6G7H8J9K0ABCD';
    await db.prepare(`INSERT INTO dev_apps (id, project_id, name, environment, oauth_client_id, client_type, redirect_uris, created_at, created_by)
        VALUES (?, ?, 'Sticker Cats', 'sandbox', 'wallet-test-client', 'public', '[]', ?, 'test') ON CONFLICT (id) DO NOTHING`).run(APP, PRJ, new Date().toISOString());

    const asked = [];
    let balanceMode = 'ok';
    let vibesMode = 'ok';
    let chargeMode = 'ok';
    let activityMode = 'missing';
    const billing = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://billing.test');
        const auth = req.headers.authorization || '';
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            asked.push({ url: url.pathname + url.search, auth, method: req.method, body });
            res.setHeader('content-type', 'application/json');
            if (url.pathname === '/api/v1/rates') return res.end(JSON.stringify({ bits_per_usd: 100, min_purchase_bits: 100, packages: [{ bits: 1000, price_cents: 1000 }], providers: { stripe: true, paypal: true } }));
            if (url.pathname === '/api/me/activity') {
                if (activityMode === 'missing') { res.statusCode = 404; return res.end(JSON.stringify({ error: 'billing.not_found' })); }
                return res.end(JSON.stringify({ activity: [
                    { id: 'txn_buy', at: '2026-11-04T10:00:00.000Z', kind: 'vibes', label: 'Got 500 Vibes with your Balance', amount: 500 },
                    { id: 'txn_buy', at: '2026-11-04T10:00:00.000Z', kind: 'balance', label: 'Got 500 Vibes with your Balance', amount: '-5000000000' },
                ] }));
            }
            if (url.pathname === '/api/v1/transactions') return res.end(JSON.stringify({ transactions: [{ id: 'txn_buy', type: 'purchase', created_at: '2026-11-04T10:00:00.000Z', metadata: { balance: 'vibes_from_balance', vibes: 500 }, entries: [
                { account: { kind: 'usd_credit', owner: `user:${subject}`, currency: 'nano-usd' }, amount: '-5000000000' },
                { account: { kind: 'user_credit', owner: subject, currency: 'vibes-bits' }, amount: 500 },
            ] }], next_cursor: null }));
            if (url.pathname === '/api/me/balance') {
                if (balanceMode === 'closed') { res.statusCode = 404; return res.end(JSON.stringify({ error: 'billing.not_enabled' })); }
                return res.end(JSON.stringify({
                    personal: { owner: { type: 'user', id: subject }, balance_nano_usd: '12400000000', held_nano_usd: '400000000', available_nano_usd: '12000000000' },
                    projects: [{ owner: { type: 'project', id: PRJ }, balance_nano_usd: '5000000000', held_nano_usd: '100000000', available_nano_usd: '4900000000' }],
                }));
            }
            if (url.pathname === '/api/me/vibes') {
                if (vibesMode === 'not_authoritative') { res.statusCode = 409; return res.end(JSON.stringify({ code: 'billing.not_authoritative' })); }
                return res.end(JSON.stringify({ subject: { type: 'user', id: subject }, currency: 'vibes-bits', credit: 1250, payable: 0, bits_per_usd: 100 }));
            }
            if (url.pathname === `/api/me/vibes/charges/${VCH}`) {
                if (chargeMode === 'missing') { res.statusCode = 404; return res.end(JSON.stringify({ error: 'billing.charge_not_found' })); }
                return res.end(JSON.stringify({ charge: { id: VCH, app: { id: 'app_01JAB2C3D4E5F6G7H8J9K0ABCD', name: 'Sticker Cats' }, amount: 50, description: 'Sticker pack: Neon cats', status: 'pending', return_url: 'https://cats.example/thanks', reference: 'order_1' }, vibes: { credit: 1250 } }));
            }
            if (url.pathname === `/api/me/vibes/charges/${VCH}/pay`) return res.end(JSON.stringify({ charge: { id: VCH, app: { name: 'Sticker Cats' }, amount: 50, description: 'Sticker pack: Neon cats', status: 'paid', return_url: 'https://cats.example/thanks' }, vibes: { credit: 1200 } }));
            if (url.pathname === `/api/me/vibes/charges/${VCH}/cancel`) return res.end(JSON.stringify({ charge: { id: VCH, status: 'cancelled' } }));
            if (url.pathname === '/api/me/balance/transfers') { res.statusCode = 201; return res.end(JSON.stringify({ transfer_id: 'btr_1', amount_nano_usd: '5000000000' })); }
            if (url.pathname === '/api/me/vibes/from-balance') { res.statusCode = 201; return res.end(JSON.stringify({ vibes: 1000, price_nano_usd: '10000000000', vibes_credit: 2250 })); }
            if (url.pathname === '/api/me/credits/topups') { res.statusCode = 201; return res.end(JSON.stringify({ intent: { id: 'pi_1' }, checkout_url: 'https://checkout.stripe.example/abc' })); }
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'billing.not_found' }));
        });
    });
    await new Promise((r) => billing.listen(0, '127.0.0.1', r));

    let authUser = { id: Number(user.id), subject_id: subject };
    const requireAuth = (req, _res, next) => { req.user = authUser; next(); };
    const app = express();
    app.use(express.json());
    app.use('/api/wallet', createWalletRoutes(db, requireAuth, {
        billingUrl: `http://127.0.0.1:${billing.address().port}`,
        selfToken: () => 'network-service-token',
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, p, { tok = 'person-token', body } = {}) => fetch(base + p, {
        method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

    try {
        const w = await call('GET', '/api/wallet');
        assert.strictEqual(w.status, 200, JSON.stringify(w.body));
        assert.strictEqual(w.body.opencoins, 340, "Network's own OpenCoins");
        assert.strictEqual(w.body.balance.personal.balance_nano_usd, '12400000000');
        assert.strictEqual(w.body.vibes.credit, 1250);
        assert.deepStrictEqual(w.body.projects.map((p) => [p.id, p.name, p.url, p.held_nano_usd, p.available_nano_usd]), [[PRJ, 'Wallet Project', `https://openvibe.services/projects/${PRJ}`, '100000000', '4900000000']]);
        assert.strictEqual(w.body.state.balance, 'open');
        assert.strictEqual(w.body.state.vibes, 'open');
        assert.strictEqual(w.body.rates.packages[0].bits, 1000);
        assert.strictEqual(w.body.activity.length, 1);
        assert.deepStrictEqual(w.body.activity[0].kinds, ['balance', 'vibes']);
        assert.deepStrictEqual(w.body.activity[0].parts, [{ kind: 'balance', amount: '-5000000000' }, { kind: 'vibes', amount: 500 }]);
        assert.strictEqual(w.body.activity[0].label, 'Got 500 Vibes with your Balance');
        assert.strictEqual(w.body.activity_source, 'journal', 'the marked fallback until Billing has /api/me/activity');
        const personActivity = asked.filter((a) => a.url.startsWith('/api/me/activity'));
        assert.strictEqual(personActivity.length, 1);
        assert.strictEqual(personActivity[0].auth, 'Bearer person-token', 'activity is asked with the person\'s own token first');
        const personCalls = asked.filter((a) => a.url.startsWith('/api/me/') && !a.url.startsWith('/api/me/activity'));
        assert.ok(personCalls.length >= 2 && personCalls.every((a) => a.auth === 'Bearer person-token'), "Billing's person reads carry the person's own token");
        const journal = asked.filter((a) => a.url.startsWith('/api/v1/transactions'));
        assert.strictEqual(journal.length, 1);
        assert.strictEqual(journal[0].auth, 'Bearer network-service-token', 'the fallback journal read carries the service token');
        assert.match(journal[0].url, new RegExp(`subject=${encodeURIComponent(subject)}`));

        // Billing ships /api/me/activity: the person's own token answers the rows; the journal is not read.
        activityMode = 'person';
        const beforePerson = asked.filter((a) => a.url.startsWith('/api/v1/transactions')).length;
        const own = await call('GET', '/api/wallet');
        assert.strictEqual(own.status, 200);
        assert.strictEqual(own.body.activity_source, 'person');
        assert.strictEqual(own.body.activity.length, 1);
        assert.deepStrictEqual(own.body.activity[0].parts, [{ kind: 'balance', amount: '-5000000000' }, { kind: 'vibes', amount: 500 }]);
        assert.strictEqual(asked.filter((a) => a.url.startsWith('/api/v1/transactions')).length, beforePerson, 'the journal fallback is not read when the person route answers');
        assert.strictEqual(asked.filter((a) => a.url.startsWith('/api/me/activity')).pop().auth, 'Bearer person-token');
        activityMode = 'missing';

        // A not-open Balance, a Vibes ledger Billing has not taken over yet: the page still draws.
        balanceMode = 'closed'; vibesMode = 'not_authoritative';
        const closed = await call('GET', '/api/wallet');
        assert.strictEqual(closed.status, 200);
        assert.strictEqual(closed.body.balance, null);
        assert.strictEqual(closed.body.state.balance, 'closed');
        assert.strictEqual(closed.body.vibes, null);
        assert.strictEqual(closed.body.state.vibes, 'not_authoritative');
        balanceMode = 'ok'; vibesMode = 'ok';

        // Writes: validated first, then forwarded with the person's token.
        let bad = await call('POST', '/api/wallet/transfers', { body: { to_project_id: PRJ, amount_nano_usd: '1.5', idempotency_key: KEY(1) } });
        assert.strictEqual(bad.status, 422, 'nano-USD is an integer string');
        bad = await call('POST', '/api/wallet/transfers', { body: { to_project_id: 'evil', amount_nano_usd: '1', idempotency_key: KEY(1) } });
        assert.strictEqual(bad.status, 422);
        bad = await call('POST', '/api/wallet/transfers', { body: { to_project_id: PRJ, amount_nano_usd: '1' } });
        assert.strictEqual(bad.status, 422, 'a money write without its idempotency key is refused');
        assert.ok(!asked.some((a) => a.url === '/api/me/balance/transfers'), 'a bad body never reaches Billing');
        const moved = await call('POST', '/api/wallet/transfers', { body: { to_project_id: PRJ, amount_nano_usd: '5000000000', idempotency_key: KEY(1) } });
        assert.strictEqual(moved.status, 201);
        const sent = asked.find((a) => a.url === '/api/me/balance/transfers');
        assert.ok(sent && sent.auth === 'Bearer person-token');
        assert.deepStrictEqual(JSON.parse(sent.body), { to_project_id: PRJ, amount_nano_usd: '5000000000', idempotency_key: KEY(1) });

        const vibes = await call('POST', '/api/wallet/vibes/from-balance', { body: { vibes: 1000, idempotency_key: KEY(2) } });
        assert.strictEqual(vibes.status, 201);
        assert.deepStrictEqual(JSON.parse(asked.find((a) => a.url === '/api/me/vibes/from-balance').body), { vibes: 1000, idempotency_key: KEY(2) });

        const topup = await call('POST', '/api/wallet/topups', { body: { provider: 'stripe', amount_cents: 2000 } });
        assert.strictEqual(topup.status, 201);
        assert.strictEqual(topup.body.checkout_url, 'https://checkout.stripe.example/abc');

        // A write without a bearer token is refused before Billing (a cookie session alone is not enough).
        const noBearer = await call('POST', '/api/wallet/vibes/from-balance', { tok: null, body: { vibes: 1000, idempotency_key: KEY(3) } });
        assert.strictEqual(noBearer.status, 401);

        // The charge carries only an app id: Network fills the name from its own app registry, and never overwrites one.
        const enriched = await createWalletRoutes.enrichCharge(db, { charge: { id: VCH, app: APP, amount: 50 } });
        assert.strictEqual(enriched.charge.app.name, 'Sticker Cats');
        const typed = await createWalletRoutes.enrichCharge(db, { charge: { id: VCH, app: { id: APP, name: 'The app’s own name' } } });
        assert.strictEqual(typed.charge.app.name, 'The app’s own name');

        // The pay sheet's charge: a vch_ id only, forwarded with the person's token.
        bad = await call('GET', '/api/wallet/charge/javascript:alert(1)');
        assert.strictEqual(bad.status, 404);
        const charge = await call('GET', `/api/wallet/charge/${VCH}`);
        assert.strictEqual(charge.status, 200);
        assert.strictEqual(charge.body.charge.app.name, 'Sticker Cats');
        assert.strictEqual(charge.body.vibes.credit, 1250);
        const paid = await call('POST', `/api/wallet/charge/${VCH}/pay`, { body: { idempotency_key: KEY(4) } });
        assert.strictEqual(paid.status, 200);
        assert.strictEqual(paid.body.charge.status, 'paid');
        assert.deepStrictEqual(JSON.parse(asked.find((a) => a.url === `/api/me/vibes/charges/${VCH}/pay`).body), { idempotency_key: KEY(4) });
        const cancelled = await call('POST', `/api/wallet/charge/${VCH}/cancel`, { body: {} });
        assert.strictEqual(cancelled.status, 200);
        chargeMode = 'missing';
        const missing = await call('GET', `/api/wallet/charge/${VCH}`);
        assert.strictEqual(missing.status, 404);
        chargeMode = 'ok';

        // Rates are cached: a second page does not ask Billing again for prices.
        const before = asked.filter((a) => a.url === '/api/v1/rates').length;
        await call('GET', '/api/wallet/rates');
        assert.strictEqual(asked.filter((a) => a.url === '/api/v1/rates').length, before, 'the pack prices are cached for a minute');

        // ── The pages ─────────────────────────────────────────
        const walletHtml = read('public', 'wallet.html');
        const payHtml = read('public', 'pay.html');
        const css = read('public', 'css', 'wallet.css');
        const payJs = read('public', 'js', 'wallet', 'pay.js');
        const pageJs = read('public', 'js', 'wallet', 'page.js');
        const sheets = read('public', 'js', 'wallet', 'sheets.js');
        const routesJs = read('server', 'wallet', 'routes.js');
        for (const page of [walletHtml, payHtml]) {
            assert.ok(page.includes('<!--ov:look-boot-->'), 'both pages paint the kept look before their stylesheet');
            assert.ok(page.includes('/shared/kit.css') && page.includes('/css/wallet.css'), 'the shared kit and the wallet styles');
            assert.ok(page.indexOf('/shared/kit.css') > page.indexOf('<!--ov:look-boot-->'), 'look-boot comes before any stylesheet');
            assert.match(page, /<meta name="robots" content="noindex, nofollow">/);
        }
        assert.match(walletHtml, /id="w-cards"/);
        assert.match(walletHtml, />Balance</);
        assert.match(walletHtml, />Vibes</);
        assert.match(walletHtml, />OpenCoins</);
        assert.match(walletHtml, />Add money</);
        assert.match(walletHtml, />Move to a project</);
        assert.match(walletHtml, />Get Vibes</);
        assert.match(walletHtml, /Earned by watching and chatting/);
        assert.match(walletHtml, /Where each works/);
        assert.ok(!/Credits/i.test(walletHtml + payHtml), 'the public word is Balance, never Credits');
        assert.ok(!/\bEarn(ing)? Vibes\b/i.test(walletHtml + payHtml + sheets + payJs), 'Vibes are bought and spent, never earned');
        assert.ok(!/<input\b|<form\b|card number/i.test(payHtml), 'the pay sheet itself never holds a card form');
        assert.match(payJs, /postMessage\(\{ type: 'ov-vibes-pay', status, charge_id: c\.id \}, u\.origin\)/, 'the opener is posted to the return_url origin only');
        assert.match(payJs, /W\.httpsUrl\(c\.returnUrl\)/, 'the return URL is https and never arbitrary');
        assert.match(css, /max-width: 420px/, 'the pay card is 420 px at most');
        assert.match(css, /\.w-cards \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/, 'three cards in a row');
        assert.match(css, /@media \(max-width: 899px\) \{ \.w-cards \{ grid-template-columns: minmax\(0, 1fr\); \}/, 'they stack on a phone');
        assert.match(css, /min-height: 44px/, 'tap targets reach 44 px');
        assert.ok(!/w-project-id/.test(pageJs), 'project rows do not print the raw project id');
        assert.match(pageJs, /w-project-ext/, 'the project name links out with a small arrow');
        assert.match(pageJs, /Available \$\{M\.money\(p\.available_nano_usd\)\}/, 'Available appears under the name only with held money');
        assert.match(pageJs, /w-act-amt--stack/, 'one transaction with both currencies stacks its two amounts');
        assert.match(pageJs, /li\.dataset\.kinds/, 'the filters read every currency on the row');
        assert.match(css, /\.w-act-amt--stack/, 'the stacked amounts are laid out');
        assert.match(routesJs, /\/api\/me\/activity/, 'Billing\'s person-token activity route is tried first');
        assert.match(routesJs, /TEMPORARY FALLBACK/, 'the service-token journal read is marked as the fallback');
        assert.ok(!/spinner|@keyframes[^}]*rotate/i.test(css + walletHtml + payHtml + sheets + payJs), 'nothing spins');
        assert.ok(!/parseFloat\s*\(/.test(read('public', 'js', 'wallet', 'money.js') + read('server', 'wallet', 'routes.js')), 'money never becomes a float');
        assert.ok(!/\.credits|credits\./.test(read('server', 'wallet', 'routes.js')), 'the API speaks Balance');

        console.log('wallet: money words, activity, proxies, pay sheet and both pages ok');
    } finally {
        server.close();
        billing.close();
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
