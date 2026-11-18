'use strict';
// The admin panel's Team tab (plan §AD.19): group conversations in the same session surface every site opens. The tab
// is there for admins, loads openvibe-shared's ov-session.js from /shared, mounts it on this Frame with the admin's own
// token, and opens the latest group.
//   node test/admin-team-tab.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'admin.html'), 'utf8');
assert.ok(html.includes("showTab('team',this)") && html.includes('id="sec-team"') && html.includes('/js/admin/team.js'), 'the tab, its section and its script');
const boot = fs.readFileSync(path.join(pub, 'js', 'admin', 'boot.js'), 'utf8');
assert.match(boot, /team: loadTeam/);
const team = fs.readFileSync(path.join(pub, 'js', 'admin', 'team.js'), 'utf8');
assert.match(team, /_teamScript\('\/shared\/ov-session\.js'\)/, 'the shared session surface, not a second UI');
assert.match(team, /base: location\.origin \+ '\/api\/frame', token: \(\) => token/, 'on this Frame, with the admin\'s own token');
assert.match(team, /_teamSession\.open\('group:' \+ latest\.id\)/, 'the latest group opens');
assert.ok(fs.existsSync(path.join(__dirname, '..', 'node_modules', 'openvibe-shared', 'ov-session.js')), 'Shared serves ov-session.js');
console.log('admin-team-tab: the Team tab mounts the shared session on this Frame and opens the latest group');
