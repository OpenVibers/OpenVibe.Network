'use strict';
/**
 * Community AI offers in OpenVibe.Network (the design's "Offer to the network"; plan E4). OpenVibe.Node's ai plugin
 * advertises one machine's local models, hours, concurrency, credit price and audience; OpenVibe.Bot reports the
 * complete set for source `bot` (POST /internal/ai/offers/report, network.resource.report); a missing offer is marked
 * down, never deleted. OpenVibe.AI reads the live ones whole with network.registry.read (GET /internal/ai/offers) and
 * places only requests that opt in to community capacity, after its canaries, model fingerprint and spot re-runs.
 *
 * It is a user-owned offer: the owner is required, nothing here is public, and this table exists rather than
 * platform_resource_offers because platform.resource-offer@1 closes its detail slot for kind node/provider and cannot
 * carry a model list, hours, a credit price and an audience. The generic registry still holds worker and desk offers.
 *
 *   POST /internal/ai/offers/report   network.resource.report   → 200 { source, offers, marked_down }
 *   GET  /internal/ai/offers          network.registry.read     → 200 { offers, generated_at, count }
 */
const express = require('express');

const SOURCE = /^[a-z][a-z0-9-]{1,39}$/;
const MAX_OFFERS = 500;
const USR = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEVICE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const AUDIENCES = new Set(['everyone', 'followers', 'group']);
const STATUSES = new Set(['up', 'degraded', 'down']);
const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000000;

function ensureSchema(db) { /* the schema is migrations/0039_ai_offers.sql; nothing is created at runtime */ }

const KEYS = new Set(['offer_id', 'machine_id', 'owner', 'models', 'hours', 'concurrency', 'price', 'audience', 'group', 'ready', 'health']);
const HEALTH_KEYS = new Set(['status', 'checked_at']);

/** One offer as Bot reports it. → null, or the problem's code. */
function checkOffer(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return 'registry.ai_offer_shape';
    // Only the offer's own fields are stored: a reporter cannot smuggle prompt text or arbitrary data into the table.
    if (Object.keys(o).some((k) => !KEYS.has(k)) || (o.health && Object.keys(o.health).some((k) => !HEALTH_KEYS.has(k)))) {
        return 'registry.ai_offer_shape';
    }
    if (typeof o.offer_id !== 'string' || !o.offer_id.startsWith('ai:')) return 'registry.ai_offer_id';
    if (typeof o.machine_id !== 'string' || !DEVICE.test(o.machine_id) || o.offer_id !== `ai:${o.machine_id}`) return 'registry.ai_offer_machine';
    if (typeof o.owner !== 'string' || !USR.test(o.owner)) return 'registry.ai_offer_owner';
    if (!Array.isArray(o.models) || o.models.length < 1 || o.models.length > 40 || o.models.some((m) => typeof m !== 'string' || !m || m.length > 200)) {
        return 'registry.ai_offer_models';
    }
    const h = o.hours;
    if (!h || typeof h !== 'object' || !HHMM.test(String(h.start)) || !HHMM.test(String(h.end)) || typeof h.tz !== 'string' || !h.tz || h.tz.length > 64) {
        return 'registry.ai_offer_hours';
    }
    if (!Number.isInteger(o.concurrency) || o.concurrency < 1 || o.concurrency > 8) return 'registry.ai_offer_concurrency';
    if (!o.price || typeof o.price !== 'object' || !isPrice(o.price.in_per_million) || !isPrice(o.price.out_per_million)) return 'registry.ai_offer_price';
    if (!AUDIENCES.has(o.audience)) return 'registry.ai_offer_audience';
    if (o.audience === 'group' && (typeof o.group !== 'string' || !o.group.trim() || o.group.length > 80)) return 'registry.ai_offer_group';
    if (typeof o.ready !== 'boolean') return 'registry.ai_offer_ready';
    if (!o.health || !STATUSES.has(o.health.status)) return 'registry.ai_offer_health';
    return null;
}

/** The whole report: {source, offers} and every offer. → null, or the 400 body for the first problem. */
function check(body) {
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
    if (!keys || keys.some((k) => k !== 'source' && k !== 'offers') || typeof body.source !== 'string' || !SOURCE.test(body.source)
        || !Array.isArray(body.offers) || body.offers.length > MAX_OFFERS) {
        return { error: `The body must be {source, offers}: source matching ${SOURCE}, at most ${MAX_OFFERS} offers` };
    }
    for (let i = 0; i < body.offers.length; i++) {
        const bad = checkOffer(body.offers[i]);
        if (bad) return { error: bad, offer: i };
    }
    return null;
}

/** Apply a checked report in one transaction; mark this source's other offers down. → { offers, marked_down } */
async function report(db, { source, offers }, now = new Date().toISOString()) {
    ensureSchema(db);
    const upsert = db.prepare(`INSERT INTO platform_ai_offers (id, source, machine_id, owner_subject, models, hours, concurrency, price_in, price_out, audience, group_id, ready, status, doc, reported_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET source = excluded.source, machine_id = excluded.machine_id, owner_subject = excluded.owner_subject,
            models = excluded.models, hours = excluded.hours, concurrency = excluded.concurrency, price_in = excluded.price_in, price_out = excluded.price_out,
            audience = excluded.audience, group_id = excluded.group_id, ready = excluded.ready, status = excluded.status, doc = excluded.doc,
            reported_at = excluded.reported_at, updated_at = excluded.updated_at`);
    let marked = 0;
    await db.tx(async () => {
        for (const o of offers) {
            await upsert.run(o.offer_id, source, o.machine_id, o.owner, JSON.stringify(o.models), JSON.stringify(o.hours), o.concurrency,
                o.price.in_per_million, o.price.out_per_million, o.audience, o.group || null, o.ready, o.health.status, JSON.stringify(o), now, now);
        }
        const ids = new Set(offers.map((o) => o.offer_id));
        for (const row of await db.prepare('SELECT id, doc FROM platform_ai_offers WHERE source = ? AND status <> ?').all(source, 'down')) {
            if (ids.has(row.id)) continue;
            const doc = JSON.parse(row.doc);
            doc.health = { ...(doc.health || {}), status: 'down' };
            doc.ready = false;
            await db.prepare('UPDATE platform_ai_offers SET doc = ?, status = ?, ready = false, updated_at = ? WHERE id = ?').run(JSON.stringify(doc), 'down', now, row.id);
            marked++;
        }
    });
    return { offers: offers.length, marked_down: marked };
}

/** The stored offers, up first, as the reporter's docs. It includes down ones so AI can show a machine is away. */
async function list(db, { source = null, owner = null } = {}) {
    ensureSchema(db);
    const where = [];
    const args = [];
    if (source) { where.push('source = ?'); args.push(source); }
    if (owner) { where.push('owner_subject = ?'); args.push(owner); }
    const rows = await db.prepare(`SELECT doc FROM platform_ai_offers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY status = 'up' DESC, id`).all(...args);
    return rows.map((r) => JSON.parse(r.doc));
}

function routers({ guard, readGuard = guard }) {
    const internal = express.Router();
    const noStore = (res) => res.set('Cache-Control', 'no-store');
    internal.get('/', readGuard, async (req, res) => {
        const offers = await list(req.app.locals.db, { source: typeof req.query.source === 'string' ? req.query.source : null,
            owner: typeof req.query.owner === 'string' ? req.query.owner : null });
        noStore(res).json({ offers, generated_at: new Date().toISOString(), count: offers.length });
    });
    internal.post('/report', guard, express.json({ limit: '256kb' }), async (req, res) => {
        const bad = check(req.body);
        if (bad) return res.status(400).json(bad);
        const out = await report(req.app.locals.db, req.body);
        noStore(res).set('X-Offers-Marked-Down', String(out.marked_down)).json({ source: req.body.source, ...out, generated_at: new Date().toISOString() });
    });
    return { internal };
}

module.exports = { ensureSchema, check, checkOffer, report, list, routers };
