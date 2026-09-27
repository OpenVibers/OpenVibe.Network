'use strict';
/** Network issues each staff member's capabilities (staff_caps) and the owner flag in user tokens (ADR-022). */
const assert = require('assert');
process.env.OWNER_USERNAME = 'theowner';
const { staff } = require('openvibe-contracts');
const { staffClaims } = require('../server/auth/staff-claims');

assert.deepStrictEqual(staffClaims({ role: 'user', username: 'a' }), {}, 'not staff: no claims, small token');
assert.deepStrictEqual(staffClaims({ role: 'streamer', username: 'b' }), {});
assert.deepStrictEqual(staffClaims({ role: 'global_mod', username: 'm' }), { staff_caps: staff.capabilitiesOf('global_mod'), staff_map: staff.map.version });
assert.deepStrictEqual(staffClaims({ role: 'admin', username: 'boss' }), { staff_caps: staff.capabilitiesOf('admin'), staff_map: staff.map.version });
const owner = staffClaims({ role: 'admin', username: 'TheOwner' });
assert.strictEqual(owner.is_owner, true);
assert.deepStrictEqual(owner.staff_caps, staff.capabilitiesOf('owner'));
assert.deepStrictEqual(staffClaims({ role: 'user', username: 'theowner' }), {}, 'the owner name without the admin role is nobody');
// Services read the issued claims exactly as the map answers.
assert.strictEqual(staff.can(owner, 'staff.secrets.manage'), true);
assert.strictEqual(staff.can(owner, 'staff.identity.merge'), true, 'account-recovery merges: the owner (map 1.2.0, ADR-029)');
assert.strictEqual(staff.can({ role: 'admin', ...staffClaims({ role: 'admin', username: 'boss' }) }, 'staff.identity.merge'), false);
assert.strictEqual(staff.can({ role: 'admin', ...staffClaims({ role: 'admin', username: 'boss' }) }, 'staff.secrets.manage'), false);
// Both user-token signers add them.
const fs = require('fs');
for (const f of ['server/auth/routes.js', 'server/auth/oauth-routes.js']) assert.ok(fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8').includes('...staffClaims(user)'), f);
console.log('staff claims: all checks passed');
