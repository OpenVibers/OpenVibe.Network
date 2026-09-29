'use strict';
/**
 * The node registry (ADR-034 section 12, roadmap WS-X1; Contracts 0.76.0 network.node@1): every machine of the
 * platform with its roles, region-level location, beacon and health. Host reports the complete set its inventory
 * knows (POST /internal/nodes/report, network.node.report); a node absent from a later report of the same source is
 * marked down, never silently deleted. GET /api/v1/nodes is public and cacheable: products and openvibe-sdk/geo
 * find "the nearest node with role R" from it. Nothing private is stored: the contract has no address field.
 */
const express = require('express');

const ensured = new WeakSet();
function ensureSchema(db) { /* the schema is migrations/NNNN_*.sql (plan T2); nothing is created at runtime */ }

/** Apply a report: upsert every node; mark this source's other nodes down. → { nodes, marked_down } */
async function report(db, { source, nodes }, now = new Date().toISOString()) {
    ensureSchema(db);
    const upsert = db.prepare(`INSERT INTO platform_nodes (id, source, doc, status, reported_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET source = excluded.source, doc = excluded.doc, status = excluded.status, reported_at = excluded.reported_at`);
    let marked = 0;
    await db.tx(async () => {
        for (const n of nodes) await upsert.run(n.id, source, JSON.stringify(n), n.health.status, now);
        const ids = new Set(nodes.map((n) => n.id));
        for (const row of await db.prepare('SELECT id, doc FROM platform_nodes WHERE source = ? AND status <> ?').all(source, 'down')) {
            if (ids.has(row.id)) continue;
            const doc = JSON.parse(row.doc);
            doc.health = { status: 'down', checked_at: now };
            doc.updated_at = now;
            await db.prepare('UPDATE platform_nodes SET doc = ?, status = ? WHERE id = ?').run(JSON.stringify(doc), 'down', row.id);
            marked++;
        }
    });
    return { nodes: nodes.length, marked_down: marked };
}

async function list(db, { role = null, region = null } = {}) {
    ensureSchema(db);
    return (await db.prepare('SELECT doc FROM platform_nodes ORDER BY id').all()).map((r) => JSON.parse(r.doc))
        .filter((n) => (!role || n.roles.includes(role)) && (!region || n.location.region === region));
}

function routers({ guard }) {
    const pub = express.Router();
    const open = (res, maxAge) => res.set('Cache-Control', maxAge ? `public, max-age=${maxAge}` : 'no-store')
        .set('Access-Control-Allow-Origin', '*').set('Timing-Allow-Origin', '*');
    pub.get('/', async (req, res) => {
        const role = typeof req.query.role === 'string' ? req.query.role : null;
        const region = typeof req.query.region === 'string' ? req.query.region : null;
        open(res, 60).json({ nodes: await list(req.app.locals.db, { role, region }), generated_at: new Date().toISOString() });
    });
    // A beacon a browser times to estimate its distance from a node (openvibe-sdk/geo). Answered by the node that
    // serves it; a report names another URL for nodes whose traffic does not come through here.
    pub.get('/:id/beacon', (req, res) => open(res, 0).status(204).end());
    const internal = express.Router();
    internal.post('/report', guard, express.json({ limit: '256kb' }), async (req, res) => {
        const { validate } = require('openvibe-contracts');
        const v = validate('network.node-report-request@1', req.body);
        if (!v.valid) return res.status(400).json({ error: 'The body does not match network.node-report-request@1', details: (v.errors || []).slice(0, 5) });
        const out = await report(req.app.locals.db, req.body);
        res.set('X-Nodes-Marked-Down', String(out.marked_down))
            .json({ nodes: await list(req.app.locals.db), generated_at: new Date().toISOString() });
    });
    return { pub, internal };
}

module.exports = { ensureSchema, report, list, routers };
