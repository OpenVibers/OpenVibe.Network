'use strict';
// SEO-27: the Organization on Network's home (#org) names every open site in sameAs, not the shell's fixed 15 of 55,
// so the entity search engines build for OpenVibe covers all of them. It follows frame/sites, as the home's list does.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SAME_AS, withSameAs } = require('../server/home/render');
const { SITES } = require('../server/frame/sites');

const open = SITES.filter((s) => s.status === 'open' && s.id !== 'network');
assert.strictEqual(SAME_AS.length, open.length + 2, 'GitHub, Discord and every open site');
assert.ok(SAME_AS.includes('https://github.com/OpenVibers'));
const missing = open.filter((s) => !SAME_AS.includes(`https://${s.host}`)).map((s) => s.host);
assert.deepStrictEqual(missing, [], 'every open site');
const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const out = withSameAs(shell);
const block = /<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@graph":[\s\S]*?)<\/script>/.exec(out);
assert.ok(block, 'the graph is there');
const org = JSON.parse(block[1])['@graph'].find((n) => n['@id'] === 'https://openvibe.network/#org');
assert.deepStrictEqual(org.sameAs, SAME_AS, 'the served Organization carries the full list, and the JSON still parses');
assert.ok(SAME_AS.length > 15);
console.log(`org sameAs: ${SAME_AS.length} entries`);
