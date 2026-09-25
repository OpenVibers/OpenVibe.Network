'use strict';
/**
 * Staff APIs (roadmap WS-D task 4), from the staff capability map in openvibe-contracts:
 *
 *   GET /api/v1/staff/capabilities   the signed-in person's role, owner flag and staff capabilities
 *   GET /api/v1/staff/moderators     the network's staff (global moderators, admins, the owner) with
 *                                    their capabilities; ?service=chat|live|community|pastes|calls keeps
 *                                    those who moderate it. For staff holding staff.moderation.logs, or a
 *                                    service token with network.staff.read (Contracts 0.47.0).
 *
 * Role assignment stays PUT /api/admin/users/:id/role (audited; only the owner grants or changes admin).
 */
const express = require('express');
const { staff } = require('openvibe-contracts');
const { staffClaims } = require('../auth/staff-claims');
const { isOwner } = require('../auth/owner-guard');

// Which staff capability moderates a service; anything else is general content moderation.
const MODERATES = { chat: 'staff.moderation.chat', live: 'staff.moderation.channels', community: 'staff.moderation.discussions', pastes: 'staff.moderation.pastes', calls: 'staff.moderation.calls' };

function staffList(db, { service = null } = {}) {
    const need = service ? (MODERATES[service] || 'staff.content.moderate') : null;
    return db.prepare("SELECT id, username, display_name, role, subject_id FROM users WHERE role IN ('global_mod', 'admin') AND COALESCE(is_banned, 0) = 0 ORDER BY role DESC, username")
        .all()
        .map((u) => {
            const owner = u.role === 'admin' && isOwner(u);
            return { subject: u.subject_id || null, username: u.username, display_name: u.display_name || u.username, role: owner ? 'owner' : u.role, is_owner: owner, capabilities: staff.capabilitiesOf({ role: u.role, is_owner: owner }) };
        })
        .filter((s) => !need || s.capabilities.includes(need));
}

function createStaffApi({ db, requireAuth, guard }) {
    const r = express.Router();
    r.get('/capabilities', requireAuth, (req, res) => {
        const claims = staffClaims(req.user);
        res.set('Cache-Control', 'private, no-store');
        res.json({ role: claims.is_owner ? 'owner' : req.user.role || 'user', is_owner: !!claims.is_owner, staff_map: staff.map.version, capabilities: claims.staff_caps || [] });
    });
    const serviceGuard = guard('network.staff.read', { legacy: false });
    const list = (req, res) => {
        const service = typeof req.query.service === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(req.query.service) ? req.query.service : null;
        res.set('Cache-Control', 'private, no-store');
        res.json({ service, staff: staffList(db, { service }) });
    };
    r.get('/moderators', (req, res, next) => {
        // A service token (sub svc:*) goes through the capability guard; a person must be staff.
        const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        let sub = '';
        try { sub = JSON.parse(Buffer.from(bearer.split('.')[1] || '', 'base64url').toString('utf8')).sub || ''; } catch { /* not a JWT */ }
        if (String(sub).startsWith('svc:')) return serviceGuard(req, res, () => list(req, res));
        return requireAuth(req, res, () => {
            if (!staff.can(staffClaims(req.user), 'staff.moderation.logs')) return res.status(403).json({ error: 'forbidden', detail: 'staff.moderation.logs required' });
            return list(req, res);
        });
    });
    return r;
}

module.exports = { createStaffApi, staffList, MODERATES };
