'use strict';

/**
 * openvibe.network/wallet — the one place a person sees and moves everything they hold (MONEY.md, D12).
 *
 * The page never talks to Billing itself: every site's CSP allows openvibe.network and not
 * billing.openvibe.network, and the person's token must not be exposed to a third origin. So Network forwards the
 * person's own Authorization header to Billing's person routes, exactly as /api/coins/me does for the navbar:
 *
 *   GET  /api/wallet                     Balance + Vibes + OpenCoins + projects + activity, one answer
 *   GET  /api/wallet/rates               Billing's public pack prices (no person data), cached a minute
 *   POST /api/wallet/transfers           personal Balance → a project's Balance
 *   POST /api/wallet/vibes/from-balance  personal Balance → Vibes, at the pack value rate
 *   POST /api/wallet/topups              Add money: start a provider checkout
 *   GET  /api/wallet/charge/:id          the Vibes Pay sheet's charge (app, item, amount, the person's Vibes)
 *   POST /api/wallet/charge/:id/pay      pay it (once, atomic in Billing)
 *   POST /api/wallet/charge/:id/cancel   cancel it
 *
 * Activity is one list over both currencies. Billing's person API has no history route, so the journal is read from
 * Billing's service API (billing.balance.read) with Network's own service token, scoped by the person's subject id:
 * only that person's rows, never another's. Money stays integer end to end: nano-USD as decimal strings and Vibes as
 * whole numbers, formatted by the browser.
 */

const express = require('express');
const wallet = require('../coins/wallet');
const config = require('../config');

const TIMEOUT_MS = 3500;
const RATES_TTL_MS = 60_000;
const CHARGE_RE = /^vch_[0-9A-HJKMNP-TV-Z]{26}$/;
// A retried write must carry the same key: the ledger moves money once for it (Billing's rule).
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
// The transactions read is a service-token capability (OpenVibe.Contracts billing.balance.read).
const BALANCE_READ = ['billing.balance.read'];
const SERVICE_AUDIENCE = 'openvibe.billing';

/** Billing's base URL, no trailing slash. */
function billingBase(opts) {
    return String(opts.billingUrl || (config.services && config.services.billing && config.services.billing.internalUrl) || '').replace(/\/+$/, '');
}

function cacheHeaders(res) {
    res.set('Cache-Control', 'private, no-store');
    return res;
}

function text(v, max = 400) {
    return String(v == null ? '' : v).slice(0, max);
}

async function readJson(r) {
    try { return await r.json(); } catch { return null; }
}

/** One request to Billing. The person's own bearer token unless `token` says otherwise. */
async function ask(url, { authorization, method = 'GET', body, timeoutMs = TIMEOUT_MS } = {}) {
    const headers = { accept: 'application/json' };
    if (authorization) headers.authorization = authorization;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(url, {
        method, headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: r.status, body: await readJson(r) };
}

function personToken(req) {
    const h = String(req.headers.authorization || '');
    return /^Bearer\s+/i.test(h) ? h : '';
}

/** The API is same-origin and reads a person's own money, so a write must carry the page's bearer token: a cookie
 *  session alone could be driven by a cross-site form. */
function bearerOnly(req, res, next) {
    if (!personToken(req)) return res.status(401).json({ error: 'token.missing', detail: 'sign in to move money' });
    return next();
}

function problem(res, status, code, detail) {
    return res.status(status).json({ error: code, detail });
}

/** The charge inside Billing's answer (a wrapper { charge } or the charge itself). */
function chargeIn(body) {
    return body && body.charge && typeof body.charge === 'object' ? body.charge : (body && typeof body === 'object' ? body : null);
}

/**
 * A pay sheet needs the app's name; Billing names it from Network's registry, but if its answer carries only the
 * app id, Network fills the name from the project it owns. An answer with a name is never overwritten.
 */
async function enrichCharge(db, body) {
    const c = chargeIn(body);
    if (!c) return body;
    const app = c.app;
    const appId = typeof app === 'string' ? app : (app && typeof app === 'object' ? app.id : c.app_id);
    if (!/^app_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(appId || ''))) return body;
    const row = await db.prepare('SELECT name FROM dev_apps WHERE id = ?').get(String(appId));
    if (!row || !row.name) return body;
    if (!c.app || typeof c.app !== 'object') c.app = { id: String(appId) };
    if (!c.app.name) c.app.name = row.name;
    if (!c.app_name) c.app_name = row.name;
    return body;
}

/** Forward Billing's answer (status, JSON, code) without inventing a second error language. */
function relay(res, out, detail) {
    cacheHeaders(res);
    if (out && out.body && typeof out.body === 'object') return res.status(out.status).json(out.body);
    return problem(res, 502, 'billing.unavailable', detail);
}

function needsSignIn(res, out) {
    return out && (out.status === 401 || out.status === 403);
}

// ── Activity: one row per currency movement on the person's own accounts ─────────────────────────

function titleCase(s) {
    return String(s || 'Activity').replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** The label and the second line of what a journal transaction was, from its type and metadata. */
function describe(t) {
    const m = (t && t.metadata) || {};
    if (t.type === 'credit' && m.credit === 'settle') return { label: 'AI usage', detail: m.model ? String(m.model) : 'Metered usage' };
    if (t.type === 'credit' && m.credit === 'topup') return { label: 'Added money', detail: 'Balance top-up' };
    if (t.type === 'purchase' && m.balance === 'vibes_from_balance') {
        return { label: `Bought ${Number(m.vibes || 0).toLocaleString('en-US')} Vibes`, detail: 'With Balance' };
    }
    if (t.type === 'purchase') {
        const bought = Number(m.vibes || m.bits || m.amount_bits || 0);
        return { label: bought ? `Bought ${bought.toLocaleString('en-US')} Vibes` : 'Bought Vibes', detail: 'With a card' };
    }
    if (t.type === 'balance_transfer') return { label: 'Moved to a project', detail: m.to_project_id ? String(m.to_project_id) : 'Project Balance' };
    if (t.type === 'donation') return { label: 'Tip', detail: m.message ? text(m.message, 80) : 'Live tip' };
    if (t.type === 'subscription' || t.type === 'subscription_share') return { label: 'Subscription', detail: 'Recurring' };
    if (t.type === 'refund') return { label: 'Refund', detail: 'Returned' };
    if (t.type === 'vibes_charge' || m.vibes_charge) return { label: m.description ? text(m.description, 80) : 'App payment', detail: 'Vibes Pay' };
    if (t.type === 'cashout_paid' || t.type === 'cashout_request') return { label: 'Cash out', detail: 'Payable' };
    return { label: titleCase(t.type), detail: '' };
}

/**
 * The person's own rows from Billing's journal (billing.transaction@1): for each currency in which their account
 * moved, one activity row. Vibes count only the spendable user_credit, never creator payable; Balance counts only
 * usd_credit, never sandbox.
 */
function mapActivity(subject, transactions) {
    if (!subject || !Array.isArray(transactions)) return [];
    const rows = [];
    for (const t of transactions) {
        if (!t || !t.id) continue;
        const entries = Array.isArray(t.entries) ? t.entries : [];
        let vibes = 0;
        let nano = 0n;
        let sawVibes = false;
        let sawNano = false;
        for (const e of entries) {
            const a = e && e.account;
            if (!a || !a.owner) continue;
            if (a.currency === 'vibes-bits' && a.kind === 'user_credit' && String(a.owner) === subject) {
                vibes += Number(e.amount) || 0;
                sawVibes = true;
            } else if (a.currency === 'nano-usd' && a.kind === 'usd_credit'
                && (String(a.owner) === subject || String(a.owner) === `user:${subject}`)) {
                nano += BigInt(String(e.amount == null ? 0 : e.amount));
                sawNano = true;
            }
        }
        const d = describe(t);
        if (sawNano && nano !== 0n) {
            rows.push({ id: `${t.id}:balance`, at: t.created_at, kind: 'balance', label: d.label, detail: d.detail, amount: nano.toString() });
        }
        if (sawVibes && vibes !== 0) {
            rows.push({ id: `${t.id}:vibes`, at: t.created_at, kind: 'vibes', label: d.label, detail: d.detail, amount: vibes });
        }
    }
    // Newest first; the same timestamp keeps journal order (Billing pages newest first already).
    rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    return rows.slice(0, 100);
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

module.exports = function createWalletRoutes(db, requireAuth, opts = {}) {
    const r = express.Router();
    const billingUrl = billingBase(opts);
    const selfToken = typeof opts.selfToken === 'function' ? opts.selfToken : null;
    let ratesCache = { at: 0, body: null };

    const json = express.json({ limit: '16kb' });

    /** Billing's public rates (packs, bits per USD): no person data, safe to cache for a minute. */
    async function rates() {
        if (ratesCache.body && Date.now() - ratesCache.at < RATES_TTL_MS) return ratesCache.body;
        if (!billingUrl) return null;
        try {
            const out = await ask(`${billingUrl}/api/v1/rates`, { timeoutMs: 2000 });
            if (out.status !== 200 || !out.body) return ratesCache.body;
            const b = out.body;
            ratesCache = {
                at: Date.now(),
                body: {
                    bits_per_usd: Number(b.bits_per_usd) || 100,
                    min_purchase_bits: Number(b.min_purchase_bits) || 100,
                    packages: Array.isArray(b.packages) ? b.packages.filter((p) => p && Number.isInteger(Number(p.bits))).slice(0, 12)
                        .map((p) => ({ bits: Number(p.bits), price_cents: Number(p.price_cents) || 0 })) : [],
                    providers: b.providers && typeof b.providers === 'object' ? b.providers : {},
                },
            };
            return ratesCache.body;
        } catch {
            return ratesCache.body;
        }
    }

    /** Billing's journal for this person, with Network's own service token: the only read the person API lacks. */
    async function activityOf(req) {
        const subject = req.user && req.user.subject_id;
        if (!subject || !selfToken) return [];
        const token = selfToken(SERVICE_AUDIENCE, BALANCE_READ);
        if (!token) return [];
        try {
            const out = await ask(`${billingUrl}/api/v1/transactions?subject=${encodeURIComponent(subject)}&limit=80`, { authorization: `Bearer ${token}` });
            if (out.status !== 200 || !out.body) return [];
            return mapActivity(subject, out.body.transactions);
        } catch {
            return [];
        }
    }

    // ── GET /api/wallet ──────────────────────────────────────
    // One answer for the page: two person reads forwarded with the person's token, the journal read with Network's
    // service token, the pack prices, and OpenCoins from Network's own ledger. A service that is down or not open
    // yet nulls its part and says so; the rest still draws.
    r.get('/', requireAuth, async (req, res) => {
        if (!billingUrl) return problem(res, 503, 'billing.unavailable', 'Billing is not configured');
        cacheHeaders(res);
        const auth = personToken(req);
        const [balance, vibes, activity, priceList] = await Promise.all([
            auth ? ask(`${billingUrl}/api/me/balance`, { authorization: auth }).catch(() => null) : null,
            auth ? ask(`${billingUrl}/api/me/vibes`, { authorization: auth }).catch(() => null) : null,
            activityOf(req),
            rates(),
        ]);

        const out = {
            opencoins: Number(await wallet.getBalance(db, req.user.id)) || 0,
            balance: null,
            vibes: null,
            projects: [],
            activity,
            rates: priceList,
            state: { balance: 'unavailable', vibes: 'unavailable' },
        };

        if (balance && balance.status === 200 && balance.body && balance.body.personal) {
            out.balance = balance.body;
            out.state.balance = 'open';
            const projects = Array.isArray(balance.body.projects) ? balance.body.projects : [];
            if (projects.length) {
                const ids = projects.map((p) => p && p.owner && p.owner.id).filter((id) => /^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || '')));
                const names = new Map();
                if (ids.length) {
                    try {
                        const rows = await db.prepare(`SELECT id, name FROM dev_projects WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
                        for (const row of rows) names.set(row.id, row.name);
                    } catch { /* names are a nicety: the balance still shows */ }
                }
                out.projects = projects
                    .filter((p) => p && p.owner && /^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(p.owner.id || '')))
                    .map((p) => ({
                        id: p.owner.id,
                        name: names.get(p.owner.id) || 'Project',
                        url: `https://openvibe.services/projects/${encodeURIComponent(p.owner.id)}`,
                        balance_nano_usd: String(p.balance_nano_usd || '0'),
                        available_nano_usd: String(p.available_nano_usd || '0'),
                    }));
            }
        } else if (balance && balance.status === 404) {
            out.state.balance = 'closed';
        }

        if (vibes && vibes.status === 200 && vibes.body && Number.isFinite(Number(vibes.body.credit))) {
            out.vibes = { credit: Number(vibes.body.credit), payable: Number(vibes.body.payable) || 0, bits_per_usd: Number(vibes.body.bits_per_usd) || (priceList ? priceList.bits_per_usd : 100) };
            out.state.vibes = 'open';
        } else if (vibes && vibes.status === 409) {
            out.state.vibes = 'not_authoritative';
        }

        return res.json(out);
    });

    // ── GET /api/wallet/rates ────────────────────────────────
    r.get('/rates', async (_req, res) => {
        const body = await rates();
        if (!body) return problem(res, 503, 'billing.rates_unavailable', 'prices are unavailable right now');
        res.set('Cache-Control', 'private, max-age=60');
        return res.json(body);
    });

    // ── POST /api/wallet/transfers ───────────────────────────
    r.post('/transfers', bearerOnly, json, async (req, res) => {
        const b = req.body || {};
        const amount = String(b.amount_nano_usd == null ? '' : b.amount_nano_usd);
        if (!/^[1-9][0-9]{0,18}$/.test(amount)) return problem(res, 422, 'wallet.invalid_amount', 'amount_nano_usd is a positive integer of nano-USD');
        if (!/^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(b.to_project_id || ''))) return problem(res, 422, 'wallet.invalid_project', 'to_project_id is a project id');
        const key = String(b.idempotency_key || '').trim();
        if (!KEY_RE.test(key)) return problem(res, 422, 'wallet.invalid_key', 'idempotency_key is 8-128 letters, digits, dot, colon, underscore or dash');
        try {
            const out = await ask(`${billingUrl}/api/me/balance/transfers`, {
                authorization: personToken(req), method: 'POST',
                body: { to_project_id: String(b.to_project_id), amount_nano_usd: amount, idempotency_key: key },
            });
            return relay(res, out, 'the transfer is unavailable');
        } catch { return problem(res, 502, 'billing.unavailable', 'the transfer is unavailable'); }
    });

    // ── POST /api/wallet/vibes/from-balance ──────────────────
    r.post('/vibes/from-balance', bearerOnly, json, async (req, res) => {
        const b = req.body || {};
        const vibes = Number(b.vibes);
        if (!Number.isSafeInteger(vibes) || vibes <= 0) return problem(res, 422, 'wallet.invalid_amount', 'vibes is a positive whole number');
        const key = String(b.idempotency_key || '').trim();
        if (!KEY_RE.test(key)) return problem(res, 422, 'wallet.invalid_key', 'idempotency_key is 8-128 letters, digits, dot, colon, underscore or dash');
        try {
            const out = await ask(`${billingUrl}/api/me/vibes/from-balance`, {
                authorization: personToken(req), method: 'POST',
                body: { vibes, idempotency_key: key },
            });
            return relay(res, out, 'the Vibes purchase is unavailable');
        } catch { return problem(res, 502, 'billing.unavailable', 'the Vibes purchase is unavailable'); }
    });

    // ── POST /api/wallet/topups ──────────────────────────────
    r.post('/topups', bearerOnly, json, async (req, res) => {
        const b = req.body || {};
        const amount = Number(b.amount_cents);
        if (!Number.isSafeInteger(amount) || amount <= 0) return problem(res, 422, 'wallet.invalid_amount', 'amount_cents is a positive whole number');
        if (!/^[a-z0-9-]{2,32}$/.test(String(b.provider || ''))) return problem(res, 422, 'wallet.invalid_provider', 'choose a payment provider');
        try {
            const out = await ask(`${billingUrl}/api/me/credits/topups`, {
                authorization: personToken(req), method: 'POST',
                body: { provider: String(b.provider), amount_cents: amount },
            });
            return relay(res, out, 'the top-up is unavailable');
        } catch { return problem(res, 502, 'billing.unavailable', 'the top-up is unavailable'); }
    });

    // ── Vibes Pay: the pay sheet's charge ────────────────────
    function chargeId(req, res) {
        const id = String(req.params.id || '');
        if (!CHARGE_RE.test(id)) { problem(res, 404, 'wallet.charge_not_found', 'no such payment link'); return null; }
        return id;
    }

    r.get('/charge/:id', requireAuth, async (req, res) => {
        const id = chargeId(req, res);
        if (!id) return;
        try {
            const out = await ask(`${billingUrl}/api/me/vibes/charges/${encodeURIComponent(id)}`, { authorization: personToken(req) });
            if (needsSignIn(res, out)) return relay(res, out, 'sign in again to see this payment');
            if (out.status === 200 && out.body) await enrichCharge(db, out.body).catch(() => { /* the name is a nicety */ });
            return relay(res, out, 'this payment link is unavailable');
        } catch { return problem(res, 502, 'billing.unavailable', 'this payment link is unavailable'); }
    });

    r.post('/charge/:id/pay', bearerOnly, json, async (req, res) => {
        const id = chargeId(req, res);
        if (!id) return;
        const b = req.body || {};
        const key = String(b.idempotency_key || '').trim();
        if (!KEY_RE.test(key)) return problem(res, 422, 'wallet.invalid_key', 'idempotency_key is 8-128 letters, digits, dot, colon, underscore or dash');
        try {
            const out = await ask(`${billingUrl}/api/me/vibes/charges/${encodeURIComponent(id)}/pay`, {
                authorization: personToken(req), method: 'POST',
                body: { idempotency_key: key },
            });
            return relay(res, out, 'the payment could not be completed');
        } catch { return problem(res, 502, 'billing.unavailable', 'the payment could not be completed'); }
    });

    r.post('/charge/:id/cancel', bearerOnly, json, async (req, res) => {
        const id = chargeId(req, res);
        if (!id) return;
        try {
            const out = await ask(`${billingUrl}/api/me/vibes/charges/${encodeURIComponent(id)}/cancel`, {
                authorization: personToken(req), method: 'POST', body: {},
            });
            return relay(res, out, 'the payment could not be cancelled');
        } catch { return problem(res, 502, 'billing.unavailable', 'the payment could not be cancelled'); }
    });

    return r;
};

module.exports.mapActivity = mapActivity;
module.exports.describe = describe;
module.exports.enrichCharge = enrichCharge;
