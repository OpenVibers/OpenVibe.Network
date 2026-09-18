'use strict';
// ═══════════════════════════════════════════════════════════════
// Tool domain registry (docs/shared-contracts.md §1).
//
// OpenVibe.Tools owns the catalog of tools and each tool's default hosts. This table holds the
// owner's overrides: "this host is the canonical / short / alias host of that tool" — including
// custom domains that are not under openvibe.tools at all. Tools reads the public list
// server-side and merges it over its code defaults.
//
//   GET  /api/domains                     public, CORS *, max-age=60 — enabled rows only
//   GET  /api/admin/domains               owner — every row + catalog status
//   POST /api/admin/domains               owner — { tool_id, host, role, enabled?, note? }
//   PUT  /api/admin/domains/:id           owner — any of the same fields
//   DELETE /api/admin/domains/:id         owner
//   GET  /api/admin/domains/catalog       owner — tools + families for the admin pickers
//   POST /api/admin/domains/check         owner — { host } → DNS readiness
//
// Invariants (enforced here, inside a transaction): a host belongs to exactly one tool; a tool has
// at most one enabled canonical and one enabled short — setting a new one demotes the previous to
// alias. Every change lands in audit_log.
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const { isOwner } = require('../auth/owner-guard');
const { ROLES, validateHost, validToolIdSyntax } = require('./validate');
const toolsCatalog = require('./catalog');
const dnsCheck = require('./dns-check');

const NOTE_MAX = 500;

function ensureSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS tool_domains (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tool_id TEXT NOT NULL,
            host TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL DEFAULT 'alias' CHECK (role IN ('canonical', 'short', 'alias')),
            enabled INTEGER NOT NULL DEFAULT 1,
            note TEXT,
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_tool_domains_tool ON tool_domains(tool_id, role, enabled);
    `);
}

function iso(sqliteTime) {
    if (!sqliteTime) return null;
    const d = new Date(String(sqliteTime).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(sqliteTime) ? '' : 'Z'));
    return isNaN(d) ? null : d.toISOString();
}

/** Which catalog tool already answers on this host by default (so it cannot be given to another). */
function catalogOwnerOf(host, catalog) {
    for (const t of catalog.tools) {
        const hosts = [t.hosts.canonical, t.hosts.short, ...(t.hosts.aliases || [])];
        try { if (t.url) hosts.push(new URL(t.url).hostname); } catch { /* */ }
        if (hosts.includes(host)) return t.id;
    }
    return null;
}

function createDomainRoutes(db, requireAuth, opts = {}) {
    ensureSchema(db);
    const catalogSource = opts.catalog || toolsCatalog;
    const checkDomain = opts.checkDomain || dnsCheck.checkDomain;
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

    const q = {
        publicList: db.prepare(`SELECT tool_id, host, role FROM tool_domains WHERE enabled = 1
            ORDER BY tool_id, CASE role WHEN 'canonical' THEN 0 WHEN 'short' THEN 1 ELSE 2 END, host`),
        lastChange: db.prepare('SELECT MAX(updated_at) AS t FROM tool_domains'),
        all: db.prepare(`SELECT d.*, u.username AS created_by_username FROM tool_domains d LEFT JOIN users u ON u.id = d.created_by
            ORDER BY d.tool_id, CASE d.role WHEN 'canonical' THEN 0 WHEN 'short' THEN 1 ELSE 2 END, d.host`),
        byId: db.prepare('SELECT * FROM tool_domains WHERE id = ?'),
        byHost: db.prepare('SELECT * FROM tool_domains WHERE host = ?'),
        holders: db.prepare('SELECT * FROM tool_domains WHERE tool_id = ? AND role = ? AND enabled = 1 AND id != ?'),
        demote: db.prepare("UPDATE tool_domains SET role = 'alias', updated_at = CURRENT_TIMESTAMP WHERE id = ?"),
        insert: db.prepare('INSERT INTO tool_domains (tool_id, host, role, enabled, note, created_by) VALUES (?, ?, ?, ?, ?, ?)'),
        update: db.prepare('UPDATE tool_domains SET tool_id = ?, host = ?, role = ?, enabled = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'),
        remove: db.prepare('DELETE FROM tool_domains WHERE id = ?'),
    };

    function audit(req, action, details) {
        try {
            db.prepare('INSERT INTO audit_log (user_id, action, details, ip) VALUES (?, ?, ?, ?)').run(req.user.id, action, JSON.stringify(details), req.ip || null);
        } catch (err) {
            console.error('[Domains] Audit log error:', err.message);
        }
    }

    const present = (row) => row && ({
        id: row.id, tool_id: row.tool_id, host: row.host, role: row.role, enabled: !!row.enabled, note: row.note || '',
        created_by: row.created_by, created_by_username: row.created_by_username || null,
        created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    });

    /**
     * Validate a proposed row. `current` is the row being edited (null on create).
     * @returns {Promise<{ error?: string, status?: number, value?: object, warnings: string[] }>}
     */
    async function validate(body, current) {
        const warnings = [];
        const next = {
            tool_id: body.tool_id !== undefined ? String(body.tool_id).trim().toLowerCase() : current && current.tool_id,
            host: body.host !== undefined ? body.host : current && current.host,
            role: body.role !== undefined ? String(body.role).trim().toLowerCase() : (current ? current.role : 'alias'),
            enabled: body.enabled !== undefined ? (body.enabled === true || body.enabled === 1 || body.enabled === '1' || body.enabled === 'true' ? 1 : 0) : (current ? current.enabled : 1),
            note: body.note !== undefined ? String(body.note == null ? '' : body.note).trim().slice(0, NOTE_MAX) : (current ? current.note : ''),
        };
        if (!ROLES.includes(next.role)) return { status: 400, error: `role must be one of ${ROLES.join(', ')}`, warnings };
        if (!validToolIdSyntax(next.tool_id)) return { status: 400, error: 'tool_id must be 1–40 characters of a–z, 0–9 and hyphen', warnings };

        const h = validateHost(next.host);
        if (!h.ok) return { status: 400, error: h.error, warnings };
        next.host = h.host;

        const { catalog, source } = await catalogSource.getCatalog();
        let toolVerified = false;
        if (source === 'fallback') {
            warnings.push('The Tools catalog is unreachable, so the tool id could not be verified. Check it again once Tools is back.');
        } else {
            const known = catalog.tools.some(t => t.id === next.tool_id) || catalog.families.some(f => f.id === next.tool_id);
            if (!known) return { status: 400, error: `"${next.tool_id}" is not a tool in the Tools catalog`, warnings };
            toolVerified = true;
            const owner = catalogOwnerOf(next.host, catalog);
            if (owner && owner !== next.tool_id) return { status: 409, error: `${next.host} already belongs to the tool "${owner}" in the Tools catalog`, warnings };
        }

        const taken = q.byHost.get(next.host);
        if (taken && (!current || taken.id !== current.id)) {
            return { status: 409, error: `${next.host} is already registered for the tool "${taken.tool_id}" — a host belongs to one tool`, warnings };
        }
        return { value: next, toolVerified, warnings };
    }

    /** Write inside one transaction; returns the row plus whatever was demoted to make room. */
    const write = db.transaction((next, current, userId) => {
        const demoted = [];
        if (next.enabled && next.role !== 'alias') {
            for (const row of q.holders.all(next.tool_id, next.role, current ? current.id : 0)) {
                q.demote.run(row.id);
                demoted.push({ id: row.id, host: row.host, from: row.role });
            }
        }
        let id;
        if (current) { q.update.run(next.tool_id, next.host, next.role, next.enabled, next.note, current.id); id = current.id; }
        else id = q.insert.run(next.tool_id, next.host, next.role, next.enabled, next.note, userId).lastInsertRowid;
        return { row: q.byId.get(id), demoted };
    });

    // ── public ───────────────────────────────────────────────
    const publicRouter = express.Router();
    publicRouter.use((req, res, next) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        if (req.method === 'OPTIONS') {
            res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
            res.set('Access-Control-Max-Age', '86400');
            return res.status(204).end();
        }
        next();
    });
    publicRouter.get('/', (_req, res) => {
        try {
            const domains = q.publicList.all();
            res.set('Cache-Control', 'public, max-age=60');
            res.json({ updated: iso(q.lastChange.get().t) || new Date(0).toISOString(), domains });
        } catch (err) {
            console.error('[Domains] public list:', err.message);
            res.status(500).json({ error: 'Could not read the domain registry' });
        }
    });

    // ── owner-only admin ─────────────────────────────────────
    const adminRouter = express.Router();
    adminRouter.use(requireAuth, (req, res, next) => {
        if (!req.user || req.user.role !== 'admin' || !isOwner(req.user)) {
            return res.status(403).json({ ok: false, error: 'Owner access required' });
        }
        res.set('Cache-Control', 'no-store');
        next();
    });

    adminRouter.get('/', async (_req, res) => {
        try {
            const { catalog, source } = await catalogSource.getCatalog();
            const known = new Set([...catalog.tools.map(t => t.id), ...catalog.families.map(f => f.id)]);
            const rows = q.all.all().map(r => ({ ...present(r), tool_known: source === 'fallback' ? null : known.has(r.tool_id) }));
            res.json({ ok: true, domains: rows, catalog_source: source });
        } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
    });

    adminRouter.get('/catalog', async (_req, res) => {
        try {
            const { catalog, source, error } = await catalogSource.getCatalog();
            res.json({
                ok: true, source, error: source === 'live' ? null : error, updated: catalog.updated,
                families: catalog.families.map(f => ({ id: f.id, name: f.name, icon: f.icon, url: f.url })),
                tools: catalog.tools.map(t => ({ id: t.id, family: t.family, name: t.name, icon: t.icon, hosts: t.hosts, url: t.url })),
            });
        } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
    });

    adminRouter.post('/check', async (req, res) => {
        const h = validateHost(req.body && req.body.host);
        if (!h.ok) return res.status(400).json({ ok: false, error: h.error });
        try { res.json({ ok: true, check: await checkDomain(h.host) }); }
        catch (err) { res.status(502).json({ ok: false, error: `DNS check failed: ${err.message}` }); }
    });

    adminRouter.post('/', async (req, res) => {
        try {
            const v = await validate(req.body || {}, null);
            if (v.error) return res.status(v.status).json({ ok: false, error: v.error, warnings: v.warnings });
            const { row, demoted } = write(v.value, null, req.user.id);
            audit(req, 'tool_domain_create', { id: row.id, tool_id: row.tool_id, host: row.host, role: row.role, enabled: !!row.enabled, demoted, tool_unverified: !v.toolVerified || undefined });
            onChange();
            res.status(201).json({ ok: true, domain: present(row), demoted, tool_verified: v.toolVerified, warnings: v.warnings });
        } catch (err) {
            if (/UNIQUE/i.test(err.message)) return res.status(409).json({ ok: false, error: 'That host is already registered' });
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    adminRouter.put('/:id', async (req, res) => {
        try {
            const current = q.byId.get(Number(req.params.id));
            if (!current) return res.status(404).json({ ok: false, error: 'Domain not found' });
            const v = await validate(req.body || {}, current);
            if (v.error) return res.status(v.status).json({ ok: false, error: v.error, warnings: v.warnings });
            const { row, demoted } = write(v.value, current, req.user.id);
            const changed = {};
            for (const k of ['tool_id', 'host', 'role', 'enabled', 'note']) if (String(current[k] ?? '') !== String(row[k] ?? '')) changed[k] = { from: current[k], to: row[k] };
            audit(req, 'tool_domain_update', { id: row.id, host: row.host, tool_id: row.tool_id, changed, demoted, tool_unverified: !v.toolVerified || undefined });
            onChange();
            res.json({ ok: true, domain: present(row), demoted, tool_verified: v.toolVerified, warnings: v.warnings });
        } catch (err) {
            if (/UNIQUE/i.test(err.message)) return res.status(409).json({ ok: false, error: 'That host is already registered' });
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    adminRouter.delete('/:id', (req, res) => {
        try {
            const current = q.byId.get(Number(req.params.id));
            if (!current) return res.status(404).json({ ok: false, error: 'Domain not found' });
            q.remove.run(current.id);
            audit(req, 'tool_domain_delete', { id: current.id, tool_id: current.tool_id, host: current.host, role: current.role });
            onChange();
            res.json({ ok: true });
        } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
    });

    return { publicRouter, adminRouter };
}

module.exports = { createDomainRoutes, ensureSchema, catalogOwnerOf };
