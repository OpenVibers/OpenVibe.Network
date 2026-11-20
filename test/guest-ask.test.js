'use strict';
// A signed-out visitor's question from the menu's box (server/frame/guest-ask.js; the plan's §V.1 guests, 2026-11-20).
// With OpenVibe.AI stood in for:
//   - the human check: a solved, signed, fresh challenge answers one question; an unsolved, forged, expired or reused
//     one is refused;
//   - the answer comes from network.guest_answer with Network's service token, attributed to the guest (a hash), with
//     the page and the site; the reply says how many are left;
//   - three a day per guest, ten per address: then 429 guest.limit with the sign-in line;
//   - the daily budget for all guests: then 503 guest.ai_paused;
//   - an answer that failed does not count; nothing is kept in the clear (keyed hashes only).
//   node test/guest-ask.test.js
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const { getDb } = require('../server/db/database');
const { createGuestAsk, MAX_NUMBER } = require('../server/frame/guest-ask');

const solve = (c) => { for (let n = 0; n <= c.maxnumber; n++) if (crypto.createHash('sha256').update(c.salt + n).digest('hex') === c.challenge) return n; return -1; };

(async () => {
    const db = getDb();
    let t = Date.parse('2026-11-20T12:00:00Z');
    const calls = [];
    let aiFails = false;
    const fetchImpl = async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
        if (aiFails) return { ok: false, status: 502, json: async () => ({ error: 'down' }) };
        return { ok: true, status: 201, json: async () => ({ run: { status: 'succeeded', output: { text: 'You can go live from your browser on openvibe.live.' }, cost_usd: 0.002, provenance: { model: 'cheap-1' } } }) };
    };
    const g = createGuestAsk({ db, secret: 'test-secret', aiUrl: 'http://ai.test', serviceToken: () => 'svc-token', fetchImpl, now: () => t, log: { warn() {} }, dailyAsks: 11, dailyUsd: 1 });
    const app = express();
    app.set('trust proxy', true);
    app.use('/api/frame/ask/guest', g.router);
    const srv = app.listen(0);
    const base = `http://127.0.0.1:${srv.address().port}/api/frame/ask/guest`;
    const ask = async (body, ip = '203.0.113.7') => {
        const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() };
    };
    const proof = async () => {
        const c = await (await fetch(`${base}/challenge`)).json();
        assert.strictEqual(c.maxnumber, MAX_NUMBER);
        return { ...c, number: solve(c) };
    };
    try {
        // The human check.
        let r = await ask({ text: 'How do I go live?' });
        assert.deepStrictEqual([r.status, r.body.code], [403, 'guest.check_failed'], 'no proof');
        const p = await proof();
        r = await ask({ text: 'How do I go live?', proof: { ...p, number: (p.number + 1) % MAX_NUMBER } });
        assert.strictEqual(r.body.reason, 'not solved');
        r = await ask({ text: 'How do I go live?', proof: { ...p, signature: 'a'.repeat(64) } });
        assert.strictEqual(r.body.reason, 'not ours', 'a forged signature');
        assert.strictEqual(calls.length, 0, 'nothing reached AI');

        // A good one: the answer, the workflow, the token, the attribution.
        r = await ask({ text: 'How do I go live?', context: 'The Go live page', site: 'live', guest: 'guest_ABCDEFGHIJKLMNOP', proof: p });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual([r.body.answer, r.body.model, r.body.left], ['You can go live from your browser on openvibe.live.', 'cheap-1', 2]);
        const call = calls[0];
        assert.strictEqual(call.url, 'http://ai.test/api/v1/runs?wait=40000');
        assert.strictEqual(call.auth, 'Bearer svc-token');
        assert.deepStrictEqual([call.body.workflow, call.body.input], ['network.guest_answer', { question: 'How do I go live?', context: 'The Go live page', site: 'live' }]);
        assert.ok(call.body.attribution.service === 'network' && call.body.attribution.type === 'guest' && /^[0-9a-f]{32}$/.test(call.body.attribution.id), 'attributed to a hash, never the id');
        r = await ask({ text: 'Again?', guest: 'guest_ABCDEFGHIJKLMNOP', proof: p });
        assert.strictEqual(r.body.reason, 'used', 'one proof, one question');
        t += 6 * 60_000;
        const old = await proof();
        t += 6 * 60_000;
        r = await ask({ text: 'Late?', guest: 'guest_ABCDEFGHIJKLMNOP', proof: old });
        assert.strictEqual(r.body.reason, 'expired');

        // Three a day per guest.
        for (let i = 0; i < 2; i++) assert.strictEqual((await ask({ text: `q${i}`, guest: 'guest_ABCDEFGHIJKLMNOP', proof: await proof() })).status, 200);
        r = await ask({ text: 'a fourth', guest: 'guest_ABCDEFGHIJKLMNOP', proof: await proof() });
        assert.deepStrictEqual([r.status, r.body.code], [429, 'guest.limit']);
        assert.match(r.body.error, /Sign in \(free\) to ask up to 100 a day/);

        // A failed answer does not count.
        aiFails = true;
        r = await ask({ text: 'down?', guest: 'guest_OTHERGUESTOTHER1', proof: await proof() }, '198.51.100.9');
        assert.deepStrictEqual([r.status, r.body.code], [502, 'guest.answer_failed']);
        aiFails = false;
        const other = await db.prepare("SELECT n FROM guest_asks WHERE scope = 'guest' AND key = ?").get(g._hashOf('guest', 'guest_OTHERGUESTOTHER1'));
        assert.strictEqual(Number(other.n), 0, 'refunded');

        // Ten per address: new guests behind the same address.
        for (let i = 0; i < 7; i++) assert.strictEqual((await ask({ text: `x${i}`, guest: `guest_ADDRESS${String(i).padStart(8, '0')}`, proof: await proof() })).status, 200, `ask ${i}`);
        r = await ask({ text: 'eleventh from this address', guest: 'guest_ADDRESSFRESH0000', proof: await proof() });
        assert.deepStrictEqual([r.status, r.body.code], [429, 'guest.limit'], 'ten per address');

        // The budget for all guests (11 questions in this test): past it, resting for today.
        r = await ask({ text: 'from elsewhere', guest: 'guest_ELSEWHEREELSEWH', proof: await proof() }, '192.0.2.1');
        assert.strictEqual(r.status, 200);
        r = await ask({ text: 'one more', guest: 'guest_ELSEWHEREELSEWH', proof: await proof() }, '192.0.2.1');
        assert.deepStrictEqual([r.status, r.body.code], [503, 'guest.ai_paused']);
        assert.match(r.body.error, /resting for today/);

        // Nothing in the clear.
        const keys = (await db.prepare("SELECT key FROM guest_asks WHERE day = '2026-11-20'").all()).map((x) => x.key);
        assert.ok(keys.every((k) => k === '*' || /^[0-9a-f]{32}$/.test(k)), keys.join(','));
        assert.ok(!keys.some((k) => k.includes('203.0') || k.includes('guest_')));
        console.log('guest ask: a human check, three a day per guest, ten per address, a budget for all; hashes only');
    } finally { srv.close(); }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
