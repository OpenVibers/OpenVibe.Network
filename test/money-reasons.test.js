'use strict';
// The plain words for an OpenCoins reason (billing.money-reason@1), and the quest catalog it names from.
const assert = require('assert');
const money = require('../server/money/reasons');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

(async () => {
    const quest = money.describe('quest:publish-a-video', { site: 'quest', resolve: { quest: (id) => ({ name: 'Publish a video', url: `https://openvibe.quest/quests/${id}` }) } });
    ok(quest.text === 'for the quest Publish a video', 'a quest key is a sentence');
    ok(quest.subject.url === 'https://openvibe.quest/quests/publish-a-video', 'with the quest as a link');
    ok(quest.site === 'OpenVibe.Quest', 'and its site in words');

    const refund = money.describe('Refund: A film', { site: 'live' });
    ok(refund.text === 'for a refund of A film' && refund.subject.name === 'A film', 'a media refund names the stream');

    const unknown = money.describe('nobody:declared-this', { site: 'fun' });
    ok(!unknown.known && unknown.text === 'for something on OpenVibe.Fun', 'an undeclared key never shows itself');

    const names = await money.questNames(async (url) => {
        assert.match(url, /\/api\/v1\/quests$/);
        return { ok: true, json: async () => ({ sites: [{ quests: [{ id: 'go-live', title: 'Go live once', url: '/quests/go-live' }] }] }) };
    });
    ok(names.get('go-live').name === 'Go live once', 'the Quest catalog names the quest');
    ok(names.get('go-live').url === 'https://openvibe.quest/quests/go-live', 'and gives its address');

    console.log(`openvibe-network money reasons: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
