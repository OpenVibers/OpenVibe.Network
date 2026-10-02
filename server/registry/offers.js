'use strict';
/**
 * The resource registry (plan T2, docs/t2-resource-registry.md; Contracts 0.83.0 platform.resource-offer@1): what the
 * network can place on — every node and provider offer, with capabilities, capacity, health and pricing. The owner
 * reports the complete set of its offers (POST /internal/resources/report, network.node.report until Contracts
 * publishes network.resource.report); an offer absent from a later report of the same source is marked down, never
 * deleted. This module stores; it does not plan, price or settle. Slice 1 is the write path only.
 */
const express = require('express');

const CONTRACT = 'platform.resource-offer@1';
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
        const v = validate(CONTRACT, body.offers[i]);
        if (!v.valid) return { error: `offer ${i} does not match ${CONTRACT}`, details: (v.errors || []).slice(0, 5) };
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

function routers({ guard }) {
    const internal = express.Router();
    internal.post('/report', guard, express.json({ limit: '256kb' }), async (req, res) => {
        const bad = check(req.body);
        if (bad) return res.status(400).json(bad);
        const out = await report(req.app.locals.db, req.body);
        res.set('Cache-Control', 'no-store').set('X-Offers-Marked-Down', String(out.marked_down))
            .json({ source: req.body.source, ...out, generated_at: new Date().toISOString() });
    });
    return { internal };
}

module.exports = { CONTRACT, DEFAULT_CELL, ensureSchema, columns, check, report, routers };
