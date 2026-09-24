'use strict';
/**
 * Staff claims in user tokens (ADR-022, openvibe-contracts manifests/policy/staff-roles.json): Network owns
 * the roles and issues each staff member's capabilities as `staff_caps`, and the owner as `is_owner: true`.
 * Services ask `staff.can(claims, 'staff.<area>.<action>')`; issued claims win over the role, so a change
 * to the map reaches every service with the next token. People who are not staff carry neither claim
 * (the map gives them nothing either way), which keeps their tokens small.
 */
const { staff } = require('openvibe-contracts');
const { isOwner } = require('./owner-guard');

function staffClaims(user) {
    if (!user) return {};
    const owner = user.role === 'admin' && isOwner(user);
    const caps = staff.capabilitiesOf({ role: user.role, is_owner: owner });
    if (!caps.length) return {};
    return { ...(owner ? { is_owner: true } : {}), staff_caps: caps, staff_map: staff.map.version };
}

module.exports = { staffClaims };
