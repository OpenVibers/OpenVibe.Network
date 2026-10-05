'use strict';
/**
 * The resource registry (plan T2, docs/t2-resource-registry.md; Contracts platform.resource-offer@1): what the
 * network can place on — resource offers with capabilities, capacity, health and pricing. The owner
 * reports the complete set of its offers (POST /internal/resources/report, network.resource.report); an offer absent
 * from a later report of the same source is marked down, never
 * deleted. This module stores; it does not plan, price or settle. Reads (slice 2): GET /api/v1/offers is public and
 * cacheable but leaves each offer's capacity out (the contract is first-party: it carries the capacity network.node@1
 * deliberately does not publish); GET /internal/resources, behind the report's guard, returns the docs whole.
 */
const express = require('express');

const CONTRACT = 'platform.resource-offer@1';
// Network's public projection of CONTRACT: capacity is absent, and harness detail.address is absent.
// The latter is required by the internal contract, so public harness docs need their own validator.
const PUBLIC_CONTRACT = 'platform.resource-offer-public@1';
const SOURCE = /^[a-z][a-z0-9-]{1,39}$/; // the same rule as network.node-report-request@1's source
const MAX_OFFERS = 500;
const DEFAULT_CELL = 'wnam-1';

function ensureSchema(db) { /* the schema is migrations/0007_resource_registry.sql (plan T2); nothing is created at runtime */ }

/** The columns copied out of a validated offer doc (design §2): the one mapping the upsert, the mark-down and the tests share. */
function columns(doc) {
    return {
        id: doc.offer_id,
        kind: doc.kind,
        region: doc.region,
        cell: doc.cell ?? DEFAULT_CELL,
        trust: doc.trust,
        status: doc.health.status,
        price_usd: doc.pricing.marginal_usd_per_unit ?? 0,
    };
}

/**
 * Check a whole report before anything is written: the Network-local envelope, then every offer against the contract.
 * → null, or the 400 body for the first problem.
 */
function check(body) {
    const { validate } = require('openvibe-contracts');
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
    if (!keys || keys.some((k) => k !== 'source' && k !== 'offers') || typeof body.source !== 'string' || !SOURCE.test(body.source)
        || !Array.isArray(body.offers) || body.offers.length > MAX_OFFERS) {
        return { error: `The body must be {source, offers}: source matching ${SOURCE}, at most ${MAX_OFFERS} offers` };
    }
    for (let i = 0; i < body.offers.length; i++) {
        const offer = body.offers[i];
        // trust may be user-owned (a person's own Node, ADR-046) since Contracts 0.90.0; migrations/0020 stores it.
        const v = validate(CONTRACT, offer);
        if (!v.valid) return { error: `offer ${i} does not match ${CONTRACT}`, details: (v.errors || []).slice(0, 5) };
        const detail = offer.detail;
        if (!detail) continue;
        if (detail.id !== offer.offer_id) return { error: 'registry.detail_id_mismatch' };
        if (detail.node != null && offer.node_id != null && detail.node !== offer.node_id) {
            return { error: 'registry.detail_node_mismatch' };
        }
        if ((detail.region != null && detail.region !== offer.region)
            || (detail.regions != null && !detail.regions.includes(offer.region))) {
            return { error: 'registry.detail_region_mismatch' };
        }
    }
    return null;
}

/** Apply a checked report in one transaction: upsert every offer; mark this source's other offers down. → { offers, marked_down } */
async function report(db, { source, offers }, now = new Date().toISOString()) {
    ensureSchema(db);
    const upsert = db.prepare(`INSERT INTO platform_resource_offers (id, source, kind, region, cell, trust, status, price_usd, doc, reported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET source = excluded.source, kind = excluded.kind, region = excluded.region, cell = excluded.cell,
            trust = excluded.trust, status = excluded.status, price_usd = excluded.price_usd, doc = excluded.doc, reported_at = excluded.reported_at`);
    let marked = 0;
    await db.tx(async () => {
        for (const o of offers) {
            const c = columns(o);
            await upsert.run(c.id, source, c.kind, c.region, c.cell, c.trust, c.status, c.price_usd, JSON.stringify(o), now);
        }
        const ids = new Set(offers.map((o) => o.offer_id));
        for (const row of await db.prepare('SELECT id, doc FROM platform_resource_offers WHERE source = ? AND status <> ?').all(source, 'down')) {
            if (ids.has(row.id)) continue;
            const doc = JSON.parse(row.doc);
            doc.health = { status: 'down', checked_at: now };
            doc.updated_at = now;
            const c = columns(doc);
            await db.prepare('UPDATE platform_resource_offers SET doc = ?, status = ? WHERE id = ?').run(JSON.stringify(doc), c.status, row.id);
            marked++;
        }
    });
    return { offers: offers.length, marked_down: marked };
}

/** The query keys list() filters on; each matches its column exactly, but max_price_usd (price_usd <= it). */
const FILTERS = ['kind', 'region', 'trust', 'status', 'cell', 'max_price_usd'];

/** Read the filters from a query string: a key given once as a string, max_price_usd a finite number >= 0; others are ignored. */
function filtersOf(query) {
    const f = {};
    for (const k of FILTERS) {
        const v = query[k];
        if (typeof v !== 'string' || v === '') continue;
        if (k !== 'max_price_usd') f[k] = v;
        else if (Number.isFinite(Number(v)) && Number(v) >= 0) f[k] = Number(v);
    }
    return f;
}

/** The offers matching the filters, in id order, as stored contract docs. Filtered in SQL; without status, down offers are left out. */
async function list(db, filters = {}) {
    ensureSchema(db);
    const where = [];
    const args = [];
    for (const k of ['kind', 'region', 'trust', 'cell']) if (filters[k] != null) { where.push(`${k} = ?`); args.push(filters[k]); }
    if (filters.status != null) { where.push('status = ?'); args.push(filters.status); } else { where.push('status <> ?'); args.push('down'); }
    if (filters.max_price_usd != null) { where.push('price_usd <= ?'); args.push(filters.max_price_usd); }
    return (await db.prepare(`SELECT doc FROM platform_resource_offers WHERE ${where.join(' AND ')} ORDER BY id`).all(...args)).map((r) => JSON.parse(r.doc));
}

/** One offer's stored contract doc, whatever its status, or null. */
async function get(db, id) {
    ensureSchema(db);
    const row = await db.prepare('SELECT doc FROM platform_resource_offers WHERE id = ?').get(id);
    return row ? JSON.parse(row.doc) : null;
}

/** The public form of an offer: capacity and harness connection address are private. */
function publicDoc({ capacity, ...doc }) {
    if (doc.kind !== 'harness' || !doc.detail) return doc;
    const { address, ...detail } = doc.detail;
    return { ...doc, detail };
}

/** Validate the public projection against CONTRACT with only its two documented redactions. */
function validatePublicDoc(doc) {
    const { validate } = require('openvibe-contracts');
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return { valid: false, errors: [{ path: '/', message: 'must be an offer object' }] };
    }
    if (Object.hasOwn(doc, 'capacity')) {
        return { valid: false, errors: [{ path: '/capacity', message: 'must be absent from the public contract' }] };
    }
    if (doc.kind !== 'harness') return validate(CONTRACT, doc);
    if (!doc.detail || typeof doc.detail !== 'object' || Array.isArray(doc.detail) || Object.hasOwn(doc.detail, 'address')) {
        return { valid: false, errors: [{ path: '/detail/address', message: 'must be absent from the public contract' }] };
    }
    // Supply a schema-valid sentinel solely for validation; it is never stored or returned.
    return validate(CONTRACT, { ...doc, detail: { ...doc.detail, address: { kind: 'cli', target: 'redacted' } } });
}

function routers({ guard }) {
    const listed = async (req, shape) => {
        const filters = filtersOf(req.query);
        const docs = (await list(req.app.locals.db, filters)).map(shape);
        return { offers: docs, generated_at: new Date().toISOString(), filters, count: docs.length };
    };
    const unknown = (res, id) => require('openvibe-contracts').http.sendProblem(res, 404, 'registry.unknown_offer', { detail: `no offer ${id}` });
    const pub = express.Router();
    const open = (res, maxAge) => res.set('Cache-Control', maxAge ? `public, max-age=${maxAge}` : 'no-store')
        .set('Access-Control-Allow-Origin', '*').set('Timing-Allow-Origin', '*');
    pub.get('/', async (req, res) => open(res, 60).json(await listed(req, publicDoc)));
    pub.get('/:offer_id', async (req, res) => {
        const doc = await get(req.app.locals.db, req.params.offer_id);
        if (!doc) return unknown(open(res, 0), req.params.offer_id);
        open(res, 60).json(publicDoc(doc));
    });
    // A beacon a browser times to estimate its distance from an offer (openvibe-sdk/geo), as nodes.js answers one.
    pub.get('/:offer_id/beacon', (req, res) => open(res, 0).status(204).end());
    const internal = express.Router();
    // The full docs, capacity included, for placement.plan() consumers: the same guard as the report.
    internal.get('/', guard, async (req, res) => res.set('Cache-Control', 'no-store').json(await listed(req, (d) => d)));
    internal.get('/:offer_id', guard, async (req, res) => {
        const doc = await get(req.app.locals.db, req.params.offer_id);
        if (!doc) return unknown(res.set('Cache-Control', 'no-store'), req.params.offer_id);
        res.set('Cache-Control', 'no-store').json(doc);
    });
    internal.post('/report', guard, express.json({ limit: '256kb' }), async (req, res) => {
        const bad = check(req.body);
        if (bad) return res.status(400).json(bad);
        // Where the offers say they run must agree with the cells and node principals Network holds (cells.js).
        const misplaced = await require('./cells').checkPlacement(req.app.locals.db, req.body.offers.map((o) => {
            const c = columns(o);
            return { cell: c.cell, node_id: o.node_id, trust: c.trust };
        }));
        if (misplaced) return require('openvibe-contracts').http.sendProblem(res, misplaced.status, misplaced.code, { detail: misplaced.detail });
        const out = await report(req.app.locals.db, req.body);
        res.set('Cache-Control', 'no-store').set('X-Offers-Marked-Down', String(out.marked_down))
            .json({ source: req.body.source, ...out, generated_at: new Date().toISOString() });
    });
    return { internal, pub };
}

module.exports = { CONTRACT, PUBLIC_CONTRACT, DEFAULT_CELL, ensureSchema, columns, check, report, list, get, publicDoc, validatePublicDoc, routers };
