'use strict';
/**
 * The network's moderation audit log (ADR-022): every staff action any service reports as an event,
 * in one place staff can read. Enforcement stays with each owner; this only records.
 *
 *   chat.moderation.action       Chat and Live moderation (Live's log goes through the chat bridge)
 *   community.moderation.action  staff actions on other people's content in Community
 *   tips.interaction.moderated   a paid message filtered, held, hidden or restored
 *   billing.staff.action         a staff money action in the Billing console
 *
 * Rows are written by the Events consumer (server/notifications/events-consumer.js) inside its inbox
 * transaction, so a redelivery records nothing twice. GET /api/v1/staff/moderation-audit lists them for
 * staff holding staff.moderation.logs (global moderators and admins), newest first, filtered by
 * service, actor or target, paged by `before` (the last row's id).
 */
const express = require('express');
const { staff } = require('openvibe-contracts');
const { staffClaims } = require('../auth/staff-claims');

const TOPICS = Object.freeze(['chat.moderation.action', 'community.moderation.action', 'tips.interaction.moderated', 'billing.staff.action']);
const str = (v, n) => (v == null || v === '' ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n));
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const json = (v) => { const s = JSON.stringify(obj(v)); return s.length > 4000 ? JSON.stringify({ truncated: true }) : s; };

function ensure(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS moderation_audit (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id       TEXT NOT NULL UNIQUE,
            service        TEXT NOT NULL,
            action         TEXT NOT NULL,
            actor_subject  TEXT,
            target_type    TEXT,
            target_id      TEXT,
            target_subject TEXT,
            scope          TEXT,
            reason         TEXT,
            details        TEXT NOT NULL DEFAULT '{}',
            occurred_at    TEXT NOT NULL,
            recorded_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_modaudit_when ON moderation_audit(occurred_at);
        CREATE INDEX IF NOT EXISTS idx_modaudit_service ON moderation_audit(service, id);
        CREATE INDEX IF NOT EXISTS idx_modaudit_actor ON moderation_audit(actor_subject, id);
    `);
}

/** One envelope → one audit row (or null when it is not an audit event). No I/O. */
function rowOf(event) {
    const p = obj(event && event.payload);
    const actor = obj(event && event.actor);
    const actorId = actor.type === 'user' ? actor.id : null;
    const base = { event_id: event.event_id, occurred_at: str(event.occurred_at || event.timestamp, 40) || new Date().toISOString() };
    switch (event.event_type) {
        case 'chat.moderation.action': {
            const d = obj(p.details);
            return { ...base, service: 'chat', action: str(p.action_type, 64) || 'unknown', actor_subject: str(p.actor_subject || actorId, 64),
                target_type: p.target_subject || p.target_user_id ? 'user' : null, target_id: str(p.target_subject || p.target_user_id, 128), target_subject: str(p.target_subject, 64),
                scope: str(`${p.scope_type || 'site'}${p.scope_id != null ? `:${p.scope_id}` : ''}`, 128), reason: str(d.reason, 500), details: json(d) };
        }
        case 'community.moderation.action': {
            const t = obj(p.target);
            return { ...base, service: 'community', action: str(p.action, 64) || 'unknown', actor_subject: str(p.actor_subject || actorId, 64),
                target_type: str(t.type, 32), target_id: str(t.id, 200), target_subject: str(t.owner_subject, 64), scope: null, reason: str(p.reason, 500), details: json(p.details) };
        }
        case 'tips.interaction.moderated': {
            const c = obj(p.creator);
            return { ...base, service: 'tips', action: `interaction.${str(p.action, 32) || 'unknown'}`, actor_subject: null,
                target_type: 'interaction', target_id: str(p.interaction_id, 64), target_subject: str(c.id, 64), scope: str(`by:${p.by || 'unknown'}`, 64), reason: null,
                details: json({ moderation_state: p.moderation_state, cancelled_effects: p.cancelled_effects }) };
        }
        case 'billing.staff.action': {
            const t = obj(p.target);
            return { ...base, service: 'billing', action: str(p.action, 64) || 'unknown', actor_subject: str(actorId, 64),
                target_type: str(t.type, 32), target_id: str(t.id, 200), target_subject: null, scope: null, reason: str(p.reason, 500), details: json(p.detail) };
        }
        default: return null;
    }
}

function createModerationAudit(db) {
    ensure(db);
    const ins = db.prepare(`INSERT OR IGNORE INTO moderation_audit (event_id, service, action, actor_subject, target_type, target_id, target_subject, scope, reason, details, occurred_at)
        VALUES (@event_id, @service, @action, @actor_subject, @target_type, @target_id, @target_subject, @scope, @reason, @details, @occurred_at)`);

    /** Inside the consumer's inbox transaction: 'recorded' or an 'ignored:*' outcome. */
    function record(event) {
        const row = rowOf(event);
        if (!row) return 'ignored:type';
        return ins.run(row).changes ? 'recorded' : 'ignored:duplicate';
    }

    function list({ service = null, actor = null, target = null, before = null, limit = 50 } = {}) {
        const where = [];
        const args = [];
        if (service) { where.push('service = ?'); args.push(String(service)); }
        if (actor) { where.push('actor_subject = ?'); args.push(String(actor)); }
        if (target) { where.push('(target_id = ? OR target_subject = ?)'); args.push(String(target), String(target)); }
        const b = parseInt(before, 10);
        if (Number.isFinite(b) && b > 0) { where.push('id < ?'); args.push(b); }
        const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const rows = db.prepare(`SELECT * FROM moderation_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, n + 1);
        const more = rows.length > n;
        const items = rows.slice(0, n).map((r) => ({ ...r, details: (() => { try { return JSON.parse(r.details); } catch { return {}; } })() }));
        return { items, next: more && items.length ? items[items.length - 1].id : null };
    }

    /** Express router for GET /api/v1/staff/moderation-audit (mount behind requireAuth). */
    function router() {
        const r = express.Router();
        r.get('/', (req, res) => {
            if (!req.user || !staff.can(staffClaims(req.user), 'staff.moderation.logs')) return res.status(403).json({ error: 'forbidden', detail: 'staff.moderation.logs required' });
            res.set('Cache-Control', 'private, no-store');
            res.json(list({ service: req.query.service, actor: req.query.actor, target: req.query.target, before: req.query.before, limit: req.query.limit }));
        });
        return r;
    }

    return { record, list, router, TOPICS };
}

module.exports = { createModerationAudit, rowOf, TOPICS };
