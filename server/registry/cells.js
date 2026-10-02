'use strict';
/**
 * Cells and node principals (plan T2 "cells now, hardware later", docs/t2-resource-registry.md section 9;
 * migrations/0008_cells_and_node_principals.sql). Network is the authority for where things run: regions, cells, the
 * node principal of every machine (nod_<ULID>: owner, trust class, home cell) and the service instances on them.
 *
 * The node-principal boundary: a report never assigns identity. Host's node report (network.node.report) creates
 * platform-owned, first-party principals for machines it is the first to name, and is refused for a machine that a
 * project owns or that was revoked. A resource offer must name a known cell, and an offer for a registered node must
 * carry that node's home cell and trust class. Today there is one cell, wnam-1 (us-west), seeded by the migration.
 */
const express = require('express');
const { ids, http } = require('openvibe-contracts');

const BOOTSTRAP_CELL = 'wnam-1';
const NODE_ID = /^[a-z][a-z0-9-]{1,39}$/; // network.node@1's id, and the 0008 CHECK

class RegistryError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

/** Boot work: every machine already in the node registry gets its platform principal (the 0008 backfill). */
async function ensureSchema(db) {
    const rows = await db.prepare(`SELECT n.id, n.doc FROM platform_nodes n
        WHERE NOT EXISTS (SELECT 1 FROM platform_node_principals p WHERE p.node_id = n.id) ORDER BY n.id`).all();
    // A row the node contract could not have produced is left for an operator rather than failing the boot.
    const nodes = rows.filter((r) => NODE_ID.test(r.id)).map((r) => { try { return { ...JSON.parse(r.doc), id: r.id }; } catch { return { id: r.id }; } });
    if (nodes.length) await db.tx(async () => adoptPlatformNodes(db, nodes, 'bootstrap'));
}

/** The cell a newly named platform machine starts in: the first active cell of its region, else wnam-1. */
async function cellForRegion(db, region) {
    const row = region ? await db.prepare("SELECT id FROM platform_cells WHERE region = ? AND status = 'active' ORDER BY id LIMIT 1").get(region) : null;
    return row ? row.id : BOOTSTRAP_CELL;
}

/** Refuse a platform report that names a machine Network does not hold as a live platform principal. Throws RegistryError. */
async function checkPlatformNodes(db, nodeIds) {
    const get = db.prepare('SELECT id, owner_kind, status FROM platform_node_principals WHERE node_id = ?');
    for (const nodeId of nodeIds) {
        const p = await get.get(nodeId);
        if (!p) continue;
        if (p.owner_kind !== 'platform') throw new RegistryError(409, 'registry.node_not_platform', `node ${nodeId} is owned by a project, not the platform`);
        if (p.status === 'revoked') throw new RegistryError(409, 'registry.node_revoked', `node ${nodeId} was revoked`);
    }
}

/** Create the platform principal of every machine not yet registered (inside the caller's transaction). → count */
async function adoptPlatformNodes(db, nodes, by, now = new Date().toISOString()) {
    const insert = db.prepare(`INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, trust, status, created_at, created_by, updated_at)
        VALUES (?, ?, ?, 'platform', 'first-party', 'active', ?, ?, ?) ON CONFLICT (node_id) DO NOTHING`);
    let added = 0;
    for (const n of nodes) {
        const cell = await cellForRegion(db, n.location && n.location.region);
        added += (await insert.run(`nod_${ids.ulid(Date.parse(now) || Date.now())}`, n.id, cell, now, by, now)).changes || 0;
    }
    return added;
}

/**
 * Check where a batch of offers says it runs, before anything is written. `items` are [{cell, node_id, trust}] in
 * report order. → null, or { status, code, detail } for the first problem.
 */
async function checkPlacement(db, items) {
    const cells = new Map((await db.prepare('SELECT id, status FROM platform_cells').all()).map((r) => [r.id, r.status]));
    const principal = db.prepare('SELECT home_cell, trust, status FROM platform_node_principals WHERE node_id = ?');
    for (let i = 0; i < items.length; i++) {
        const { cell, node_id: nodeId, trust } = items[i];
        if (!cells.has(cell)) return { status: 400, code: 'registry.unknown_cell', detail: `offer ${i}: no cell ${cell}` };
        if (cells.get(cell) === 'retired') return { status: 409, code: 'registry.cell_retired', detail: `offer ${i}: cell ${cell} is retired` };
        const p = nodeId ? await principal.get(nodeId) : null;
        if (!p) continue;
        if (p.status === 'revoked') return { status: 409, code: 'registry.node_revoked', detail: `offer ${i}: node ${nodeId} was revoked` };
        if (p.home_cell !== cell) return { status: 409, code: 'registry.node_cell_mismatch', detail: `offer ${i}: node ${nodeId} lives in ${p.home_cell}, not ${cell}` };
        if (p.trust !== trust) return { status: 409, code: 'registry.trust_mismatch', detail: `offer ${i}: node ${nodeId} has trust class ${p.trust}, not ${trust}` };
    }
    return null;
}

const cellView = (r) => ({ id: r.id, region: r.region, residency: r.residency, status: r.status, route_weight: Number(r.route_weight) });

async function listCells(db) {
    return (await db.prepare('SELECT * FROM platform_cells ORDER BY id').all()).map(cellView);
}

async function getCell(db, id) {
    const r = await db.prepare('SELECT * FROM platform_cells WHERE id = ?').get(String(id));
    return r ? cellView(r) : null;
}

/** Everything registered in one cell: its nodes (owner, trust, health), service instances and offers. Internal only. */
async function topology(db, id) {
    const cell = await getCell(db, id);
    if (!cell) return null;
    const health = new Map((await db.prepare('SELECT id, status FROM platform_nodes').all()).map((r) => [r.id, r.status]));
    const nodes = (await db.prepare('SELECT * FROM platform_node_principals WHERE home_cell = ? ORDER BY node_id').all(cell.id)).map((p) => ({
        principal_id: p.id, node_id: p.node_id, owner: { kind: p.owner_kind, project_id: p.project_id || null },
        trust: p.trust, status: p.status, health: health.get(p.node_id) || 'unknown',
    }));
    const instances = (await db.prepare('SELECT * FROM platform_service_instances WHERE cell = ? ORDER BY service, id').all(cell.id)).map((r) => ({
        id: r.id, service: r.service, version: r.version, node: r.node_id, endpoints: JSON.parse(r.endpoints), state: r.state,
        route_weight: Number(r.route_weight), started_at: r.started_at, reported_at: r.reported_at,
    }));
    const offers = (await db.prepare('SELECT doc FROM platform_resource_offers WHERE cell = ? ORDER BY id').all(cell.id)).map((r) => {
        const o = JSON.parse(r.doc);
        return { offer_id: o.offer_id, kind: o.kind, node_id: o.node_id || null, trust: o.trust, status: o.health.status, capabilities: o.capabilities || [], capacity: o.capacity || {} };
    });
    return { cell, nodes, instances, offers };
}

function routers({ readGuard }) {
    const pub = express.Router();
    const open = (res) => res.set('Cache-Control', 'public, max-age=60').set('Access-Control-Allow-Origin', '*').set('Timing-Allow-Origin', '*');
    pub.get('/', async (req, res) => {
        open(res).json({ cells: await listCells(req.app.locals.db), generated_at: new Date().toISOString() });
    });
    pub.get('/:id', async (req, res) => {
        const cell = await getCell(req.app.locals.db, req.params.id);
        if (!cell) return http.sendProblem(res, 404, 'registry.unknown_cell', { detail: `no cell ${req.params.id}` });
        open(res).json(cell);
    });
    const internal = express.Router();
    internal.get('/cells/:id', readGuard, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const t = await topology(req.app.locals.db, req.params.id);
        if (!t) return http.sendProblem(res, 404, 'registry.unknown_cell', { detail: `no cell ${req.params.id}` });
        res.json({ ...t, generated_at: new Date().toISOString() });
    });
    return { pub, internal };
}

module.exports = { BOOTSTRAP_CELL, RegistryError, ensureSchema, checkPlatformNodes, adoptPlatformNodes, checkPlacement, listCells, getCell, topology, routers };
