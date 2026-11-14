'use strict';
// The AI tab in plain words (public/js/admin/ai.js; OWNER-SETUP-AND-ADMIN-CLARITY-DESIGN, 2026-11-07, sections 2
// and 3): the table's words for billing, access, keys and health; a title with the machine key small and grey after
// it (a key without a title reads as words); every choice from x-enum-labels; x-advanced fields and raw JSON in a
// counted "Advanced settings (N)" fold; an object with described properties as a small form; an unset secret offers
// the write-only route.
//   node test/admin-ai-clarity.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin', 'ai.js'), 'utf8');
const ctx = {
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    timeAgo: () => '2h ago', currentUser: null, console,
};
vm.createContext(ctx);
vm.runInContext(src + '\n;globalThis.__pai = { paiSetupOnly, paiField, paiCard, paiKeyState, paiHealth, paiHumanize, PAI_BILLING_LABEL, PAI_ACCESS_LABEL, paiProviderRow };', ctx);
const P = ctx.__pai;

// ── The table's words, verbatim ──
// A namespace made only of non-AI owner inputs (Codes' publishing tokens) is the Setup tab's, not "AI settings".
{
    const oi = (group) => ({ type: 'string', 'x-owner-input': { group, unlocks: 'x' } });
    assert.strictEqual(P.paiSetupOnly({ schema: { properties: { npm_token: oi('design-publishing'), chrome: oi('design-publishing') } } }), true);
    assert.strictEqual(P.paiSetupOnly({ schema: { properties: { key: oi('ai-providers'), npm_token: oi('design-publishing') } } }), false, 'one AI input keeps it on the AI tab');
    assert.strictEqual(P.paiSetupOnly({ schema: { properties: { model: { type: 'string' } } } }), false, 'a plain AI setting stays');
    assert.strictEqual(P.paiSetupOnly({ schema: { properties: {} } }), false);
}
assert.deepStrictEqual({ ...P.PAI_BILLING_LABEL }, {
    metered: 'Spends Credits per request', subscription: 'A plan with a monthly fee shared by everyone',
    payg: 'A prepaid balance at the provider', free: 'Free', byok: 'The person\'s own key pays',
});
assert.deepStrictEqual({ ...P.PAI_ACCESS_LABEL }, {
    OWN_DEPLOYMENT: 'Runs on our own machine: no provider terms', AUTHORIZED_WHOLESALE: 'Our agreement allows reselling it',
    CUSTOMER_BYOK: 'Only with the person\'s own key', RESTRICTED: 'Do not sell: their terms forbid it',
    UNVERIFIED: 'Not checked yet: treated as Do not sell',
});
assert.match(P.paiKeyState({ secret_ref: 'vault:deepseek', credentials: 'configured', auth_mode: 'bearer', base_url: 'https://api.deepseek.com' }).text, /^Key: Entered here, locked/);
assert.strictEqual(P.paiKeyState({ secret_ref: 'env:DEEPSEEK_API_KEY', credentials: 'configured', auth_mode: 'bearer' }).text, 'Key: From the server\'s settings file (DEEPSEEK_API_KEY)');
assert.strictEqual(P.paiKeyState({ secret_ref: null, credentials: 'missing', auth_mode: 'bearer' }).text, 'Key: Not set');
assert.strictEqual(P.paiHealth({ health: { state: 'closed' } }).text, 'Health: Working');
assert.strictEqual(P.paiHealth({ health: { state: 'half_open' } }).text, 'Health: Testing again');
assert.match(P.paiHealth({ health: { state: 'open', consecutive_failures: 5, opened_at: Date.UTC(2026, 10, 7, 14, 4) } }).text, /^Health: Paused after 5 errors; tries again at \d{1,2}[:.]\d{2}/);
const row = P.paiProviderRow({ key: 'openrouter', display_name: 'OpenRouter', base_url: 'https://openrouter.ai', secret_ref: 'env:X', credentials: 'configured', auth_mode: 'bearer', billing_profile: 'metered', provider_access: 'UNVERIFIED', status: 'active', health: { state: 'closed' } });
assert.ok(!/circuit|half.open|Sealed|vault|BYOK|Metered/i.test(row.replace(/data-act="[^"]*"/g, '')), 'no internal word is shown on a provider row');

// ── Titles, keys, choices ──
const n = {
    service: 'ai', namespace: 'ai.exchange', revision: 3, pins: [],
    values: { min_samples: 5, routing: 'auto', limits: { per_minute: 20 }, raw: { a: 1 }, alpha: 0.2 },
    classification: { min_samples: 'internal', routing: 'internal', limits: 'internal', raw: 'internal', alpha: 'internal' },
    schema: {
        title: 'What the Exchange offers', type: 'object',
        properties: {
            min_samples: { type: 'integer', description: 'Below this many attempts, evidence is reported and never trusted.' },
            routing: { type: 'string', title: 'How a model is chosen', enum: ['auto', 'pinned'], 'x-enum-labels': { auto: { label: 'By what works best for the money', description: 'Measured cost per success decides' } } },
            limits: { type: 'object', title: 'Per person limits', properties: { per_minute: { type: 'integer', title: 'Requests a minute' } } },
            raw: { type: 'object', title: 'Route overrides' },
            alpha: { type: 'number', title: 'How fast new measurements count', 'x-advanced': true },
            provider_key: { type: 'string', title: 'Provider key' },
        },
    },
};
const f = P.paiField(n, 'min_samples', n.schema.properties.min_samples, false, null);
assert.match(f, /<label>Min samples <code>min_samples<\/code><\/label>/, 'a key without a title reads as words, the key small after it');
const choice = P.paiField(n, 'routing', n.schema.properties.routing, false, null);
assert.match(choice, /<option value="auto" selected data-desc="Measured cost per success decides">By what works best for the money<\/option>/, 'an option in words with its line');
assert.match(choice, /<option value="pinned">Pinned<\/option>/, 'an option without a label still reads as a word');
const form = P.paiField(n, 'limits', n.schema.properties.limits, false, null);
assert.match(form, /data-pai-object/, 'an object whose properties are described is a small form');
assert.ok(!/<textarea/.test(form), 'not raw JSON');
const secret = P.paiField(n, 'provider_key', n.schema.properties.provider_key, false, null);
assert.match(secret, /Not set/);
assert.match(secret, /data-act="secret"[^>]*>(<i[^>]*><\/i> )?Enter it</, 'an unset key goes to the write-only route, not a plain field');
const card = P.paiCard(n);
assert.match(card, /<h5>What the Exchange offers <code class="pai-mkey">ai\.exchange<\/code><\/h5>/, 'the card title, with the namespace small after it');
assert.match(card, /<summary>Advanced settings \(2\)<\/summary>/, 'x-advanced and raw JSON fold under a counted Advanced settings');
const [mainPart, advancedPart] = card.split('<details class="pai-advanced">');
assert.ok(!/<textarea/.test(mainPart), 'raw JSON is only under Advanced settings');
assert.match(advancedPart, /data-key="raw"/);
assert.match(advancedPart, /data-key="alpha"/);
assert.match(card, /Saved version 3/);
assert.strictEqual(P.paiHumanize('vast.key'), 'Vast key');
console.log('admin-ai-clarity: the table\'s words, titles, choices, folds and forms render as designed');
