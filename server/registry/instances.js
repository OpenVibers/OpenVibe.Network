'use strict';
/**
 * Service instances (plan T2, docs/t2-cells-and-node-principal.md section 4.1; Contracts
 * platform.service-instance@1; migrations/0008_cells_and_node_principals.sql): what runs on the platform's machines —
 * one row per running instance with its cell, node, endpoints and state. Host reports the complete set its inventory
 * knows (POST /internal/registry/instances/report, network.node.report); an instance absent from a later report of the
 * same source is set to `stopped`, never deleted. Placement is checked against what Network holds before anything is
 * written: the cell must exist and not be retired, the node must be a live principal whose home cell is the instance's
 * cell, and the instance's region must be the cell's region. Endpoints are stored as JSON text; no public route
 * (instances carry endpoints).
 */
const express = require('express');

const CONTRACT = 'platform.service-instance@1';
const SOURCE = /^[a-z][a-z0-9-]{1,39}$/; // the same rule as network.node-report-request@1's source
const MAX_INSTANCES = 500;

function ensureSchema(db) { /* the schema is migrations/0008_cells_and_node_principals.sql; nothing is created at runtime */ }

/**
 * Check a whole report before anything is written: the Network-local envelope, then every instance against the
 * contract. → null, or the 400 body for the first problem.
 */
function check(body) {
    const { validate } = require('openvibe-contracts');
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
    if (!keys || keys.some((k) => k !== 'source' && k !== 'instances') || typeof body.source !== 'string' || !SOURCE.test(body.source)
        || !Array.isArray(body.instances) || body.instances.length > MAX_INSTANCES) {
        return { error: `The body must be {source, instances}: source matching ${SOURCE}, at most ${MAX_INSTANCES} instances` };
    }
    for (let i = 0; i < body.instances.length; i++) {
        const v = validate(CONTRACT, body.instances[i]);
        if (!v.valid) return { error: `instance ${i} does not match ${CONTRACT}`, details: (v.errors || []).slice(0, 5) };
    }
    return null;
}

/**
 * Check where a batch of instances says it runs, against the cells and node principals Network holds. Throws
 * RegistryError for the first problem, so a refused report writes nothing.
 */
async function checkPlacement(db, instances) {
    const RegistryError = require('./cells').RegistryError;
    const cells = new Map((await db.prepare('SELECT id, region, status FROM platform_cells').all()).map((r) => [r.id, r]));
    const principal = db.prepare('SELECT home_cell, status FROM platform_node_principals WHERE node_id = ?');
    for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        const cell = cells.get(inst.cell);
        if (!cell) throw new RegistryError(400, 'registry.unknown_cell', `instance ${i}: no cell ${inst.cell}`);
        if (cell.status === 'retired') throw new RegistryError(409, 'registry.cell_retired', `instance ${i}: cell ${inst.cell} is retired`);
        const p = await principal.get(inst.node);
        if (!p) throw new RegistryError(400, 'registry.unknown_node', `instance ${i}: no node principal ${inst.node}`);
        if (p.status === 'revoked') throw new RegistryError(409, 'registry.node_revoked', `instance ${i}: node ${inst.node} was revoked`);
        if (p.home_cell !== inst.cell) throw new RegistryError(409, 'registry.node_cell_mismatch', `instance ${i}: node ${inst.node} lives in ${p.home_cell}, not ${inst.cell}`);
        if (cell.region !== inst.region) throw new RegistryError(400, 'registry.region_mismatch', `instance ${i}: cell ${inst.cell} is in ${cell.region}, not ${inst.region}`);
    }
}

/**
 * Apply a report: check the whole batch, then in one transaction upsert every instance by id (route_weight is left
 * untouched on update — the scheduler owns weights, section 8) and set this source's other instances to `stopped`.
 * Throws RegistryError, writing nothing, when a check fails. → { instances, stopped }
 */
async function report(db, { source, instances } = {}, now = new Date().toISOString()) {
    ensureSchema(db);
    const bad = check({ source, instances });
    if (bad) {
        const e = new (require('./cells').RegistryError)(400, 'registry.invalid_report', bad.error);
        e.details = bad.details;
        throw e;
    }
    await checkPlacement(db, instances);
    const upsert = db.prepare(`INSERT INTO platform_service_instances (id, service, version, cell, node_id, endpoints, state, source, started_at, reported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET service = excluded.service, version = excluded.version, cell = excluded.cell,
            node_id = excluded.node_id, endpoints = excluded.endpoints, state = excluded.state, source = excluded.source,
            started_at = excluded.started_at, reported_at = excluded.reported_at`);
    let stopped = 0;
    await db.tx(async () => {
        for (const inst of instances) {
            await upsert.run(inst.id, inst.service, inst.version, inst.cell, inst.node, JSON.stringify(inst.endpoints), inst.state, source, inst.started_at, now);
        }
        const ids = new Set(instances.map((i) => i.id));
        for (const row of await db.prepare('SELECT id FROM platform_service_instances WHERE source = ? AND state <> ?').all(source, 'stopped')) {
            if (ids.has(row.id)) continue;
            await db.prepare('UPDATE platform_service_instances SET state = ?, reported_at = ? WHERE id = ?').run('stopped', now, row.id);
            stopped++;
        }
    });
    return { instances: instances.length, stopped };
}

function routers({ guard }) {
    const { http } = require('openvibe-contracts');
    const internal = express.Router();
    internal.post('/report', guard, express.json({ limit: '256kb' }), async (req, res) => {
        let out;
        try {
            out = await report(req.app.locals.db, req.body || {});
        } catch (e) {
            if (e instanceof require('./cells').RegistryError) return http.sendProblem(res, e.status, e.code, { detail: e.message, errors: e.details });
            throw e;
        }
        res.set('Cache-Control', 'no-store').set('X-Instances-Stopped', String(out.stopped))
            .json({ source: req.body.source, ...out, generated_at: new Date().toISOString() });
    });
    return { internal };
}

module.exports = { CONTRACT, ensureSchema, check, checkPlacement, report, routers };
