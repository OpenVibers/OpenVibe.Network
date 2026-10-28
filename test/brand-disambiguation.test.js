'use strict';
// Who OpenVibe is, said so search engines and AI cannot take it for something else (the owner, 2026-10-28: Google's AI
// Overview for "whois openvibe" described an unrelated "Openvibe" mobile app). The home page's Organization names the
// network, its other names, what it is and what it is not, and its sites; llms.txt opens the same way.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const graph = blocks.flatMap((b) => b['@graph'] || [b]);
const org = graph.find((x) => x['@type'] === 'Organization');
assert.ok(org, 'the home page has the Organization');
assert.strictEqual(org['@id'], 'https://openvibe.network/#org', 'the one @id every site\'s pages point at');
assert.deepStrictEqual(org.alternateName, ['OpenVibe Network', 'OpenVibers']);
assert.ok(/open-source, community-run network of websites/.test(org.description) && /OpenVibe\.Live/.test(org.description) && /OpenVibe\.Tools/.test(org.description), 'what it is');
assert.ok(/not the Openvibe mobile social-media aggregator app/.test(org.disambiguatingDescription), 'what it is not');
['https://github.com/OpenVibers', 'https://openvibe.live', 'https://openvibe.tools', 'https://openvibe.chat', 'https://openvibe.wiki', 'https://openre.stream']
    .forEach((u) => assert.ok(org.sameAs.includes(u), `sameAs ${u}`));

const llms = require('../server/home/render').llmsTxt();
assert.ok(/^# OpenVibe Network/m.test(llms));
assert.ok(llms.includes('OpenVibe (openvibe.network, made by OpenVibers) is an open source, community-run network of websites'), 'llms.txt says what it is');
assert.ok(llms.includes('It is not the Openvibe mobile social-media aggregator app, which is unrelated.'), 'and what it is not');
console.log('brand disambiguation: Organization and llms.txt ok');
