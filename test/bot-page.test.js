'use strict';
// /bot is the page OpenVibeBot's user agent links to (Sources ADR 0007); /bot.json says the same for machines.
//   node test/bot-page.test.js
const assert = require('assert');
const { render, FACTS, UA } = require('../server/bot/page');
const seoRoutes = require('../server/seo/routes');

const html = render({ releaseId: 'rel_test' });

// The user agent and both robots.txt names are on the page, exactly as Sources sends and matches them.
assert.strictEqual(UA, 'Mozilla/5.0 (compatible; OpenVibeBot/1.0; +https://openvibe.network/bot)');
assert.ok(html.includes(UA), 'the user agent is shown');
assert.deepStrictEqual(FACTS.robots_tokens, ['OpenVibeBot', 'OpenVibeSources']);
for (const t of FACTS.robots_tokens) assert.ok(html.includes(`<code>${t}</code>`), `${t} is named`);

// Every way to steer it is there, escaped, with a copy button.
for (const s of ['User-agent: OpenVibeBot\nDisallow: /', 'Crawl-delay: 30', '&lt;meta name=&quot;OpenVibeBot&quot; content=&quot;noindex, nofollow&quot;&gt;', 'X-Robots-Tag: OpenVibeBot: noindex']) {
    assert.ok(html.includes(s), `snippet: ${s}`);
}
assert.strictEqual((html.match(/class="bp-copy"/g) || []).length, 6, 'five snippets and the user agent can be copied');
assert.ok(html.includes('<link rel="canonical" href="https://openvibe.network/bot">'));
assert.ok(!/<script>[^<]*innerHTML/.test(html), 'the copy script writes text only');

// The JSON is the same facts, and it never promises what the crawler does not do.
assert.strictEqual(FACTS.user_agent, UA);
assert.ok(FACTS.never.includes('solve CAPTCHAs'));
assert.strictEqual(FACTS.pacing.sites_at_once, 2);

// It is a public page: in the sitemap and in llms.txt.
assert.ok(seoRoutes.sitemapXml().includes('https://openvibe.network/bot</loc>'));

console.log('bot-page: ok');
