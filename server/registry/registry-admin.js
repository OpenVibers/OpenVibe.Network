'use strict';
/**
 * Operator writers and reads for the registry (plan T2, docs/t2-cells-and-node-principal.md section 8): the routing
 * weight and the draining lifecycle of a cell, a service instance and a node principal. These are routing decisions,
 * so no report carries them; a staff session sets them, next to /api/admin/deploy. No service capability is involved.
 * Nothing routes on a weight or on draining until a scheduler and a route consumer exist. Every change lands in
 * audit_log.
 *   GET /api/admin/registry/node-principals?cell=&owner_kind=&status=   → { node_principals: [...] }
 *   PUT /api/admin/registry/cells/:id             { route_weight?, status? } → the cell
 *   PUT /api/admin/registry/instances/:id         { route_weight?, state? }  → the instance
 *   PUT /api/admin/registry/node-principals/:id   { status }                 → the principal (active or draining)
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { RegistryError, setCell } = require('./cells');
const { setInstance } = require('./instances');
const { principalFilter, listPrincipals, setPrincipalStatus } = require('./node-principals');

/** The body of a PUT: a JSON object with at least one of `allowed` and nothing else. Throws RegistryError. */
function fields(body, allowed) {
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
    if (!keys || !keys.length || keys.some((k) => !allowed.includes(k))) {
        throw new RegistryError(400, 'registry.invalid_body', `the body must be an object with ${allowed.join(' and/or ')}`);
    }
    return body;
}

function createRegistryAdmin(db, requireAuth, requireAdmin) {
    const router = express.Router();
    router.use(requireAuth, requireAdmin, express.json({ limit: '4kb' }));
    const send = (fn) => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            res.json(await fn(req));
        } catch (e) {
            if (e instanceof RegistryError) return http.sendProblem(res, e.status, e.code, { detail: e.message });
            console.error('[Registry admin]', e.message);
            return http.sendProblem(res, 500, 'registry.failed', { detail: 'the registry could not be read or changed' });
        }
    };
    // The write and its audit row together, so a change is never unaudited.
    const write = (req, action, fn) => db.tx(async () => {
        const out = await fn();
        await db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
            .run(req.user.id, action, JSON.stringify({ id: req.params.id, ...req.body }));
        return out;
    });

    router.get('/node-principals', send(async (req) => ({
        node_principals: await listPrincipals(db, principalFilter(req.query)), generated_at: new Date().toISOString(),
    })));
    router.put('/cells/:id', send((req) => {
        const body = fields(req.body, ['route_weight', 'status']);
        return write(req, 'registry_cell_update', () => setCell(db, req.params.id, body));
    }));
    router.put('/instances/:id', send((req) => {
        const body = fields(req.body, ['route_weight', 'state']);
        return write(req, 'registry_instance_update', () => setInstance(db, req.params.id, body));
    }));
    router.put('/node-principals/:id', send((req) => {
        const { status } = fields(req.body, ['status']);
        return write(req, 'registry_node_principal_update', () => setPrincipalStatus(db, req.params.id, status));
    }));
    return router;
}

module.exports = { createRegistryAdmin };
