'use strict';
// Removed on purpose (the owner, 2026-11-13): account reservation keys ("no one needs it … no remnants"), the Deploy tab
// and the SSH tab ("security risk … get rid of it"; deploys are ovhost's and changes go through git.openvibe.codes, Codes
// and the agents), and the Glossary tab (its words open in place, beside the word). Nothing of them is left to call.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const exists = (p) => fs.existsSync(path.join(__dirname, '..', p));

const html = read('public/admin.html');
for (const tab of ['vkeys', 'deploy', 'ssh', 'glossary']) {
    assert.ok(!html.includes(`showTab('${tab}'`) && !html.includes(`id="sec-${tab}"`), `no ${tab} tab or section`);
}
assert.ok(!/js\/admin\/deploy\.js/.test(html), 'no Deploy script');
for (const f of ['public/js/admin/deploy.js', 'server/deploy/routes.js', 'server/deploy/nginx-generator.js']) assert.ok(!exists(f), `${f} is gone`);

const index = read('server/index.js');
assert.ok(!/api\/admin\/deploy|ssh-info|createDeployRoutes/.test(index), 'no Deploy or SSH route');
const admin = read('server/admin/routes.js');
assert.ok(!/verification-keys/.test(admin), 'no reservation key routes');
const auth = read('server/auth/routes.js');
assert.ok(!/verification_key|isUsernameReserved|redeemVerificationKey/.test(auth), 'sign-up takes no claim code');
const db = read('server/db/database.js');
assert.ok(!/VerificationKey|isUsernameReserved/.test(db), 'no reservation key helpers');
assert.ok(!/claim-code|verification_key/.test(read('public/login.html') + read('public/js/login.js')), 'the sign-up form has no claim code');
const core = read('public/js/admin/core.js');
assert.ok(!/deployCurrentSubTab|showDeploySubTab|'deploy'/.test(core), 'no Deploy routing in the panel');
console.log('admin-removed-1113: reservation keys, Deploy, SSH and the Glossary tab are gone, with nothing left to call');
