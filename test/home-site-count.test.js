'use strict';
// One count of the sites on the front door (the owner, 2026-11-06: a phone showed "51 sites, one front door" above
// "All 52 sites, grouped by what you came to do"). Every number of sites the home page prints is the count /sites
// prints: every open site, this front door included, from the frame's list, never a number typed in.
const assert = require('assert');
const activity = require('../server/home/activity');
const home = require('../server/home/render');
const sitesPage = require('../server/sites/page');
const { LISTED } = require('../server/frame/sites');

activity.setEnabled(false);
const expected = LISTED.filter((s) => s.status === 'open').length;
const { html } = home.render();
const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const counts = [...text.matchAll(/\b(\d+|[A-Za-z]+) (?:open )?sites\b/g)].map((m) => m[1]).map((n) => (/^\d+$/.test(n) ? Number(n) : WORDS.indexOf(n.toLowerCase())))
    .filter((n) => n > 1);   // "all sites", "other sites" and the like are words, not counts
assert.ok(counts.length >= 4, `the page states its count in several places (found ${counts.length})`);
assert.deepStrictEqual([...new Set(counts)], [expected], `every count of sites on the home is ${expected}: ${counts.join(', ')}`);
const sites = sitesPage.render();
assert.ok(sites.includes(`All ${expected} OpenVibe sites`), '/sites says the same number');
console.log(`home site count: ${counts.length} mentions, all ${expected}, the same as /sites`);
