'use strict';
/**
 * A signed-out visitor's question from the menu's box (2026-11-20; the plan's §V.1 guests, the owner's register #801:
 * "anons should be able to … use AI features with abuse prevention, severe rate limits … a global cap").
 *
 *   GET  /api/frame/ask/guest/challenge   { algorithm, salt, challenge, maxnumber, signature }
 *   POST /api/frame/ask/guest             { text, context?, site?, guest?, proof }  → 200 { answer, model, left }
 *
 * The gate, in order:
 *   1. a proof of work (ALTCHA's scheme): the browser finds the number n ≤ maxnumber whose SHA-256 of salt + n is the
 *      challenge (a second or two); the challenge is signed here, lives five minutes and is good for one question;
 *   2. a daily budget for all guests (questions and dollars): past it, 503 guest.ai_paused, "resting for today";
 *   3. three questions a day per guest (the id the browser keeps) and ten per address: 429 guest.limit with the
 *      sign-in line (an account asks 100 a day).
 * The answer is OpenVibe.AI's network.guest_answer, run with Network's own service token: no tools, no search, no
 * files, 450 tokens, the cheapest interactive model, attributed to the guest. Counters are by day in guest_asks, keyed
 * by keyed hashes (never an address or an id in the clear).
 */
const crypto = require('crypto');
const express = require('express');

const MAX_NUMBER = 100_000;          // the work: on average 50k SHA-256s in the browser
const CHALLENGE_MS = 5 * 60_000;
const PER_GUEST = 3;
const PER_ADDRESS = 10;
const GUEST_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SITE_RE = /^[a-z][a-z0-9-]{0,39}$/;

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const today = (ms) => new Date(ms).toISOString().slice(0, 10);

function createGuestAsk({
    db, secret, aiUrl = 'http://127.0.0.1:4700', serviceToken, fetchImpl = globalThis.fetch, now = Date.now, log = console,
    dailyAsks = Number(process.env.NETWORK_GUEST_AI_DAILY_ASKS) || 3000,
    dailyUsd = Number(process.env.NETWORK_GUEST_AI_DAILY_USD) || 5,
} = {}) {
    if (!secret) throw new Error('guest ask: a secret is required');
    const key = crypto.createHash('sha256').update(`guest-ask:${secret}`).digest();
    const hmac = (s) => crypto.createHmac('sha256', key).update(s).digest('hex');
    const hashOf = (kind, v) => hmac(`${kind}:${v}`).slice(0, 32);
    const used = new Map();   // challenge → expiry: each proof answers one question
    const aiBase = String(aiUrl || '').replace(/\/+$/, '');

    function challenge() {
        const expires = now() + CHALLENGE_MS;
        const salt = `${crypto.randomBytes(12).toString('hex')}?expires=${Math.floor(expires / 1000)}`;
        const number = crypto.randomInt(0, MAX_NUMBER + 1);
        const c = sha256hex(salt + number);
        return { algorithm: 'SHA-256', salt, challenge: c, maxnumber: MAX_NUMBER, signature: hmac(c) };
    }

    /** A proof is good once, before it expires, signed here, and solved. → null or the refusal's reason. */
    function checkProof(p) {
        if (!p || typeof p !== 'object') return 'no proof';
        const salt = String(p.salt || ''), c = String(p.challenge || ''), sig = String(p.signature || '');
        const n = Number(p.number);
        if (!/^[0-9a-f]{24}\?expires=\d{10}$/.test(salt) || !/^[0-9a-f]{64}$/.test(c) || !/^[0-9a-f]{64}$/.test(sig)) return 'malformed';
        if (!Number.isSafeInteger(n) || n < 0 || n > MAX_NUMBER) return 'malformed';
        const expires = Number(salt.split('=')[1]) * 1000;
        if (!(expires > now())) return 'expired';
        const want = Buffer.from(hmac(c), 'hex'), got = Buffer.from(sig, 'hex');
        if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return 'not ours';
        if (sha256hex(salt + n) !== c) return 'not solved';
        for (const [k, at] of used) if (at < now()) used.delete(k);
        if (used.has(c)) return 'used';
        used.set(c, expires);
        return null;
    }

    const bump = (day, scope, k, dn, dusd) => db.prepare(`INSERT INTO guest_asks (day, scope, key, n, cost_usd) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (day, scope, key) DO UPDATE SET n = guest_asks.n + excluded.n, cost_usd = guest_asks.cost_usd + excluded.cost_usd`).run(day, scope, k, dn, dusd);
    const count = async (day, scope, k) => {
        const r = await db.prepare('SELECT n, cost_usd FROM guest_asks WHERE day = ? AND scope = ? AND key = ?').get(day, scope, k);
        return { n: Number(r && r.n) || 0, usd: Number(r && r.cost_usd) || 0 };
    };

    async function answer({ question, context, site, guestKey }) {
        const r = await fetchImpl(`${aiBase}/api/v1/runs?wait=40000`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceToken()}` },
            body: JSON.stringify({
                workflow: 'network.guest_answer',
                input: { question, ...(context ? { context } : {}), ...(site ? { site } : {}) },
                attribution: { service: 'network', type: 'guest', id: guestKey },
            }),
            signal: AbortSignal.timeout(45_000),
        });
        const j = await r.json().catch(() => null);
        const run = j && j.run;
        const text = run && run.output && typeof run.output.text === 'string' ? run.output.text.trim() : '';
        if (!r.ok || !run || !(run.status === 'succeeded' || run.status === 'cached') || !text) {
            const err = new Error((j && (j.detail || j.error)) || 'The answer could not be written.');
            err.status = 502;
            throw err;
        }
        const prov = run.provenance && typeof run.provenance === 'object' ? run.provenance : {};
        const usd = Number(run.cost_usd ?? (run.usage && run.usage.cost_usd) ?? prov.cost_usd) || 0;
        const receipt = run.receipt && typeof run.receipt.why === 'string' ? { chose: clean(run.receipt.chose || '', 120) || null, why: clean(run.receipt.why, 300) } : null;
        return { text: clean(text, 4000), model: prov.model || null, usd: usd > 0 ? usd : 0, receipt };
    }

    const router = express.Router();
    router.get('/challenge', (req, res) => { res.set('Cache-Control', 'no-store').json(challenge()); });
    router.post('/', express.json({ limit: '16kb' }), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const b = req.body || {};
        const question = clean(b.text, 1000);
        if (question.length < 2) return res.status(422).json({ error: 'Ask a question', code: 'guest.ask_invalid' });
        const why = checkProof(b.proof);
        if (why) return res.status(403).json({ error: 'The quick check did not go through: try again', code: 'guest.check_failed', reason: why });
        const day = today(now());
        const guestKey = GUEST_RE.test(String(b.guest || '')) ? hashOf('guest', b.guest) : hashOf('ip-guest', req.ip || '');
        const ipKey = hashOf('ip', req.ip || '');
        const [all, mine, here] = await Promise.all([count(day, 'all', '*'), count(day, 'guest', guestKey), count(day, 'ip', ipKey)]);
        if (all.n >= dailyAsks || all.usd >= dailyUsd) {
            return res.status(503).json({ error: 'Guest questions are resting for today. Sign in (free) to keep asking.', code: 'guest.ai_paused' });
        }
        if (mine.n >= PER_GUEST || here.n >= PER_ADDRESS) {
            return res.status(429).json({ error: `That was today's ${PER_GUEST} guest questions. Sign in (free) to ask up to 100 a day.`, code: 'guest.limit' });
        }
        await Promise.all([bump(day, 'all', '*', 1, 0), bump(day, 'guest', guestKey, 1, 0), bump(day, 'ip', ipKey, 1, 0)]);
        try {
            const a = await answer({ question, context: clean(b.context, 2000), site: SITE_RE.test(String(b.site || '')) ? String(b.site) : '', guestKey });
            if (a.usd > 0) await bump(day, 'all', '*', 0, a.usd);
            res.json({ answer: a.text, model: a.model, left: Math.max(0, PER_GUEST - mine.n - 1), ...(a.receipt ? { receipt: a.receipt } : {}) });
        } catch (err) {
            // Nothing was answered: the question does not count.
            await Promise.all([bump(day, 'all', '*', -1, 0), bump(day, 'guest', guestKey, -1, 0), bump(day, 'ip', ipKey, -1, 0)]).catch(() => {});
            if (log && log.warn) log.warn('[GuestAsk] no answer:', err.message);
            res.status(502).json({ error: 'Vibe could not answer right now. Try again in a moment.', code: 'guest.answer_failed' });
        }
    });

    return { router, challenge, checkProof, _hashOf: hashOf };
}

module.exports = { createGuestAsk, MAX_NUMBER, PER_GUEST, PER_ADDRESS };
