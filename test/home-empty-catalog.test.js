'use strict';
// The home page before the Tools catalog has ever been fetched (the built-in fallback catalog is gone, plan T2): no
// "0 tools", no empty family or chip rows, and llms.txt leaves out a section with no links.
const assert = require('assert');
const catalog = require('../server/domains/catalog');
const home = require('../server/home/render');

const { catalog: c } = catalog.peek();
assert.strictEqual(c.tools.length, 0, 'this process has not reached Tools');
const { html } = home.render();
assert.ok(!/\b0 tools\b/.test(html), 'no "0 tools" heading');
assert.ok(!/\b0 online tools\b/.test(html), 'no "0 online tools" in the hero');
assert.ok(/Tools that just open/.test(html), 'the section still says what Tools is');
assert.ok(/free online tools/.test(html), 'the hero reads "free online tools"');
assert.ok(!/<div class="sc-grid"><\/div>/.test(html) && !/<ul class="home-chips[^"]*"><\/ul>/.test(html), 'no empty rows');
assert.ok(/<section class="sc-sec" id="tools"[^>]*>[\s\S]*?href="https:\/\/openvibe\.tools\/"/.test(html), 'the tools section still links openvibe.tools');
assert.ok(!/<li>Online tools: /.test(html), 'the AI summary facts leave out a tool count it does not know');
const txt = home.llmsTxt();
assert.ok(!/Tool families/.test(txt), 'llms.txt leaves out the empty Tool families section');
assert.ok(/Sites/.test(txt) && /Machine-readable/.test(txt));
console.log('home with an empty catalog: all checks passed');
