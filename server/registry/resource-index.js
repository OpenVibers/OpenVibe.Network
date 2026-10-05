'use strict';
/**
 * Network's authority resource index (ADR-048 section 3; capability network.resource.read):
 *
 *   GET /api/v1/resources[?project=&kind=&cursor=&limit=]  → common.resource-list-result@1
 *   GET /api/v1/resources/:ovrn                            → common.resource-summary@1
 *
 * It pages the resources OpenVibe.Network owns — its developer projects (prj_), their apps (app_) and
 * its node principals (nod_) — as common.resource-summary@1, the shape OpenVibe.Services fans out over
 * and merges (openvibe-sdk/resources' createResourceIndex). The T2 Fabric offer registry used to share
 * this path; the amended ADR-048 moves its public routes to /api/v1/offers (server/registry/offers.js).
 *
 * Tenancy: `?project=prj_…` is the caller's tenancy boundary. With it, only that project's resources
 * answer — the project itself, its apps and its project-owned machines; a resource of another project
 * is never returned. Without it the first-party caller (the capability is first-party) sees every
 * Network-owned resource, which is what an authority-wide fan-out needs.
 *
 * OVRN: a summary's ovrn is computed with openvibe-contracts' contracts.resources.nameOf, the one
 * formatter, so it is present exactly when the resource is a nameable resource. Per ADR-048 section 3
 * a project is addressed by its bare prj_ id — it is never given a self-referential OVRN — and an app
 * is an actor, never a resource name (app_ is excluded from the OVRN id pattern). A project-owned node
 * principal is named ovrn:network:<prj_…>:node/nod_…; a platform- or user-owned one has no project
 * segment and so no name. That is also what GET /api/v1/resources/:ovrn can read: only a resource
 * whose computed ovrn equals the one asked for answers.
 */
const express = require('express');
const contracts = require('openvibe-contracts');

const SERVICE = 'network';
const PROJECT_KIND = 'network.project';
const APP_KIND = 'network.app';
const NODE_KIND = 'network.node';
const KINDS = [PROJECT_KIND, APP_KIND, NODE_KIND];
const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** A subject-ref {type:'user', id} for a stored subject, or null when it is not a usr_ id. */
const userRef = (subject) => (USER_SUBJECT_RE.test(String(subject || '')) ? { type: 'user', id: subject } : null);

/** common.resource-summary@1 for a dev_projects row. A project's tenancy boundary is itself. */
function projectSummary(p) {
    return {
        id: p.id, kind: PROJECT_KIND, service: SERVICE, project_id: p.id,
        ...(userRef(p.owner_subject) ? { owner: userRef(p.owner_subject) } : {}),
        name: p.name, state: p.archived_at ? 'archived' : 'active', created_at: p.created_at,
    };
}

/** common.resource-summary@1 for a dev_apps row (an OAuth client; its project is its tenancy boundary). */
function appSummary(a) {
    return {
        id: a.id, kind: APP_KIND, service: SERVICE, project_id: a.project_id, name: a.name,
        state: a.revoked_at ? 'revoked' : 'active', created_at: a.created_at,
    };
}

/** common.resource-summary@1 for a platform_node_principals row: platform-, project- or user-owned. */
function nodeSummary(n) {
    return {
        id: n.id, kind: NODE_KIND, service: SERVICE,
        ...(n.project_id ? { project_id: n.project_id } : {}),
        ...(userRef(n.owner_subject) ? { owner: userRef(n.owner_subject) } : {}),
        ...(n.name ? { name: n.name } : {}),
        state: n.status, created_at: n.created_at, updated_at: n.updated_at,
    };
}

/**
 * The summary's ovrn, or null when it has none. ADR-048 section 3: a project is addressed by its bare
 * prj_ id and never carries a self-referential OVRN, so the kind is checked before the contracts
 * helper (which would otherwise compose ovrn:network:<prj_…>:project/<prj_…>). Apps fail the helper's
 * id rule (app_ is excluded); only a project-owned node principal composes.
 */
function ovrnOf(summary) {
    if (summary.kind === PROJECT_KIND) return null;
    return contracts.resources.nameOf(summary);
}

/** The summary with its ovrn attached when it has one. */
function named(summary) {
    const ovrn = ovrnOf(summary);
    return ovrn ? { ...summary, ovrn } : summary;
}

/** A stable (kind, id) ordering, so a cursor can be a position in it. */
const order = (x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** The summaries matching the filters: `project` scopes tenancy, `kind` picks one kind. Sorted by (kind, id). */
// Scope: network.resource.read is first-party (resourceConstraints none), so its holder sees every project and
// ?project= only narrows. If it is ever granted to a non-first-party principal, derive the scope from that
// principal's grants here instead of trusting the query.
async function collect(db, { project = null, kind = null } = {}) {
    const out = [];
    if (!kind || kind === PROJECT_KIND) {
        const rows = project
            ? await db.prepare('SELECT * FROM dev_projects WHERE id = ?').all(project)
            : await db.prepare('SELECT * FROM dev_projects ORDER BY id').all();
        for (const p of rows) out.push(named(projectSummary(p)));
    }
    if (!kind || kind === APP_KIND) {
        const rows = project
            ? await db.prepare('SELECT * FROM dev_apps WHERE project_id = ? ORDER BY id').all(project)
            : await db.prepare('SELECT * FROM dev_apps ORDER BY id').all();
        for (const a of rows) out.push(named(appSummary(a)));
    }
    if (!kind || kind === NODE_KIND) {
        const rows = project
            ? await db.prepare('SELECT * FROM platform_node_principals WHERE project_id = ? ORDER BY id').all(project)
            : await db.prepare('SELECT * FROM platform_node_principals ORDER BY id').all();
        for (const n of rows) out.push(named(nodeSummary(n)));
    }
    return out.sort(order);
}

/** A cursor is an opaque base64url [kind, id] position; only one this index issued decodes to that. */
const encodeCursor = (s) => Buffer.from(JSON.stringify([s.kind, s.id])).toString('base64url');
function decodeCursor(raw) {
    let v;
    try { v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch { return null; }
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' ? v : null;
}
const afterCursor = (s, [kind, id]) => s.kind > kind || (s.kind === kind && s.id > id);

/** The query as filters, or { error } for a value that cannot be honoured. An unknown kind is kept (it matches nothing). */
function filtersOf(query) {
    const project = typeof query.project === 'string' && query.project !== '' ? query.project : null;
    if (project && !PROJECT_ID_RE.test(project)) return { error: 'project must be a prj_ id' };
    const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : null;
    let limit = DEFAULT_LIMIT;
    if (typeof query.limit === 'string' && query.limit !== '') {
        if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > MAX_LIMIT) return { error: `limit must be an integer 1-${MAX_LIMIT}` };
        limit = Number(query.limit);
    }
    let cursor = null;
    if (typeof query.cursor === 'string' && query.cursor !== '') {
        cursor = decodeCursor(query.cursor);
        if (!cursor) return { error: 'cursor is not one this index issued' };
    }
    return { project, kind, limit, cursor };
}

function router({ guard }) {
    const open = (res) => res.set('Cache-Control', 'private, max-age=60');
    const bad = (res, detail) => contracts.http.sendProblem(res, 400, 'resources.bad_query', { detail });
    const unknown = (res, name) => contracts.http.sendProblem(res, 404, 'resources.unknown_resource', { detail: `no resource named ${name}` });

    /** One common.resource-list-result@1 page: the filtered, sorted summaries from the cursor, then `limit` of them. */
    async function page(req, res) {
        const f = filtersOf(req.query);
        if (f.error) return bad(res, f.error);
        const all = await collect(req.app.locals.db, f);
        const rest = f.cursor ? all.filter((s) => afterCursor(s, f.cursor)) : all;
        const resources = rest.slice(0, f.limit);
        const next_cursor = rest.length > f.limit ? encodeCursor(resources[resources.length - 1]) : null;
        open(res).json({ resources, next_cursor });
    }

    /** GET /api/v1/resources/:ovrn: the summary whose computed ovrn is exactly the one asked for. */
    async function one(req, res) {
        const name = String(req.params.ovrn);
        const parsed = contracts.resources.parse(name);
        const db = req.app.locals.db;
        let summary = null;
        if (parsed && parsed.service === SERVICE) {
            if (parsed.type === 'node') {
                const row = await db.prepare('SELECT * FROM platform_node_principals WHERE id = ?').get(parsed.id);
                if (row) summary = named(nodeSummary(row));
            } else if (parsed.type === 'app') {
                const row = await db.prepare('SELECT * FROM dev_apps WHERE id = ?').get(parsed.id);
                if (row) summary = named(appSummary(row));
            } else if (parsed.type === 'project') {
                const row = await db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(parsed.id);
                if (row) summary = named(projectSummary(row));
            }
        }
        if (!summary || summary.ovrn !== name) return unknown(res, name);
        open(res).json(summary);
    }

    const r = express.Router();
    r.get('/', guard, page);
    r.get('/:ovrn', guard, one);
    return r;
}

module.exports = { router, SERVICE, KINDS, PROJECT_KIND, APP_KIND, NODE_KIND, DEFAULT_LIMIT, MAX_LIMIT, projectSummary, appSummary, nodeSummary, ovrnOf, collect, encodeCursor };
