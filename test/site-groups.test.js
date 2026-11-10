'use strict';
// The owner's one site list (2026-11-10, plan ask 274): eight groups, in this order, at most seven tiles each,
// every site in exactly one of them (or a named merge with a domain that keeps answering). The same list feeds the
// menu, its You-tab folders, the footer's Network column and the home pages' "More on OpenVibe".
const assert = require('assert');
const contracts = require('openvibe-contracts');
const {
    SITES, LISTED, LISTED_SITES, GROUPS, groupOf, PRODUCTS, MERGED_SITES, MERGED_PRODUCTS,
    MENU_LINE, MENU_NAME, siteForHost,
} = require('../server/frame/sites');

const LABELS = ['Watch & stream', 'Talk & belong', 'Play', 'Read & ask', 'Shop & money', 'Free tools', 'Make with AI', 'For developers'];
assert.deepStrictEqual(GROUPS.map((g) => g.name), LABELS, 'the eight labels, in the order the menu, footer and homes show');
assert.deepStrictEqual(GROUPS.map((g) => g.id), ['watch', 'talk', 'play', 'read', 'shop', 'tools', 'make', 'build'], 'the ids Contracts `site.neighbourhood` and Shared folders use');

// At most seven tiles a group, and every listed place in exactly one group.
for (const g of GROUPS) assert.ok(g.sites.length <= 7, `${g.name}: ${g.sites.length} tiles`);
for (const s of LISTED) assert.strictEqual(GROUPS.filter((g) => g.sites.includes(s.id)).length, 1, `${s.id}: exactly one group`);
assert.deepStrictEqual(GROUPS.map((g) => g.sites.length), [7, 7, 7, 7, 7, 7, 6, 7]);
assert.strictEqual(LISTED.filter((s) => s.status === 'open').length, 55, 'the one number: 53 open sites plus Pics and Download');
assert.deepStrictEqual(PRODUCTS.map((p) => LISTED.find((s) => s.id === p.id).status), ['open', 'open'], 'Pics and Download are open entries');

// Every manifest site is in one group, or is one of the named merges: Media into Video, Bench into Report,
// Homes into Rent (no manifest of its own) and Play into Games. `website` has no site and is in no list.
const named = new Set([...MERGED_SITES.keys(), ...MERGED_PRODUCTS.map((p) => p.id), 'play']);
const manifestSites = contracts.services.manifests.filter((m) => m.site);
for (const m of manifestSites) {
    const id = m.site.icon;
    const grouped = GROUPS.some((g) => g.sites.includes(id));
    assert.ok(grouped || named.has(id), `${id}: in a group or a named merge`);
    assert.ok(!grouped || groupOf(id) === m.site.neighbourhood, `${id}: manifest neighbourhood ${m.site.neighbourhood} is its group`);
}
assert.ok(!GROUPS.some((g) => g.sites.includes('website')), 'Website (Space\'s second domain, no site) is in no list');
assert.ok(!['media', 'homes', 'bench'].some((id) => GROUPS.some((g) => g.sites.includes(id))), 'the merged sections have no tile');

// Names everywhere: Email, Restream, Studio and Locker; never the id or the old product name.
const nameOf = (id) => MENU_NAME[id] || (LISTED.find((s) => s.id === id) || {}).name;
assert.deepStrictEqual(['mail', 'stream', 'image', 'lock'].map(nameOf), ['Email', 'Restream', 'Studio', 'Locker']);
assert.deepStrictEqual(['media', 'homes', 'bench', 'website'].filter((id) => LISTED.some((s) => s.id === id)), [], 'merged sections and Website are not listed');

// Every tile keeps its one menu line.
for (const s of LISTED) assert.ok(MENU_LINE[s.id] && MENU_LINE[s.id].length <= 28, `${s.id}: one line (${MENU_LINE[s.id]})`);

// A merged section keeps its own domain answering; the frame gives it the section's home.
assert.strictEqual(siteForHost('openvibe.homes').id, 'rent', 'Homes belongs to Rent');
assert.strictEqual(siteForHost('bench.openvibe.services').id, 'report', 'Bench belongs to Report');
assert.strictEqual(siteForHost('openvibe.media').id, 'media', 'Media still answers; it is Video\'s API, not a tile');
assert.ok(SITES.some((s) => s.id === 'media'), 'Media stays a known host');

console.log(`site groups: ${LISTED.filter((s) => s.status === 'open').length} open places in ${GROUPS.length} groups, at most seven a group, every manifest site placed`);
