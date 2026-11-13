'use strict';
// The feed says who posted it and what a deal costs (the owner, 11-13: "it should say who posted it,
// and it should show like … their level … more details of the user … their username effects"; "update
// the listings for deals"). feed.item@1 1.1.0: actor.handle, actor.level, actor.fx and
// group.items[].price / was / store.
const assert = require('assert');
const express = require('express');
const contracts = require('openvibe-contracts');
const { ids } = require('openvibe-contracts');
const { getDb } = require('../server/db/database');
const store = require('../server/feed/store');
const { createFeedApi } = require('../server/feed/api');

(async () => {
    const db = getDb();
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const shown = ids.newId('user');        // their level is on the leaderboard
    const hidden = ids.newId('user');       // their level is not
    const alex = await db.prepare("INSERT INTO users (username, display_name, password_hash, subject_id, avatar_url) VALUES ('moosely', 'Moosely', 'x', ?, 'https://openvibe.media/o/med_01M6SV8DWZHBBBR370DPGXGXPH') RETURNING id").get(shown);
    const robin = await db.prepare("INSERT INTO users (username, display_name, password_hash, subject_id) VALUES ('robin', 'Robin', 'x', ?) RETURNING id").get(hidden);
    await db.prepare('INSERT INTO person_levels (user_id, xp, level) VALUES (?, 5000, 7)').run(alex.id);
    await db.prepare('INSERT INTO person_levels (user_id, xp, level, leaderboard) VALUES (?, 100, 3, false)').run(robin.id);

    await store.upsertItem(db, { source_service: 'community', source_type: 'paste', source_id: 'pic-1', kind: 'pic',
        title: 'A picture', text: 'Current read', url: 'https://openvibe.community/p/pic-1', site: 'community', site_name: 'Community',
        actor_subject: shown, counts: {}, occurred_at: iso(now - 60000) });
    await store.upsertItem(db, { source_service: 'community', source_type: 'paste', source_id: 'pic-2', kind: 'pic',
        title: 'Another picture', text: '', url: 'https://openvibe.community/p/pic-2', site: 'community', site_name: 'Community',
        actor_subject: hidden, counts: {}, occurred_at: iso(now - 120000) });

    // The feed's server asks OpenVibe.Inventory for the name effect a person wears.
    const asked = [];
    const inventoryOk = async (url) => {
        asked.push(String(url));
        return {
            ok: true, status: 200,
            json: async () => ({ equipped: [{ subject: shown, slots: { 'live.name_effect:effect': { token: 'name-fx-rainbow' } } }] }),
        };
    };
    const inventoryDown = async () => { throw new Error('inventory is down'); };

    const serve = async (fetchImpl) => {
        const feed = createFeedApi({ db, config: { feed: { inventoryUrl: 'https://inventory.test' } }, fetchImpl,
            publicKey: '', startCollectors: false, now: () => now });
        const app = express();
        app.use('/api/v1/feed', feed.router);
        const server = app.listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        return {
            async get(p) {
                const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
                return { status: res.status, body: await res.json() };
            },
            close: () => server.close(),
        };
    };

    const up = await serve(inventoryOk);
    const page = await up.get('/api/v1/feed?site=community&limit=10');
    assert.strictEqual(page.status, 200);
    const mine = page.body.items.find((i) => i.id === 'f:community:paste:pic-1');
    assert.ok(mine, 'the picture is in the feed');
    assert.strictEqual(mine.actor.name, 'Moosely');
    assert.strictEqual(mine.actor.handle, 'moosely', 'the card names the person by their username');
    assert.strictEqual(mine.actor.level, 7, 'and by their level');
    assert.strictEqual(mine.actor.fx, 'name-fx-rainbow', 'and by the name effect they wear');
    assert.ok(asked.some((u) => u.startsWith('https://inventory.test/api/v1/equipped?subjects=')), 'the feed asked Inventory itself');
    assert.ok(asked.some((u) => u.includes(shown)), 'for that person');
    const theirs = page.body.items.find((i) => i.id === 'f:community:paste:pic-2');
    assert.strictEqual(theirs.actor.handle, 'robin');
    assert.strictEqual(theirs.actor.level, null, 'a person who hides their level sends null, not a guess');
    assert.strictEqual(theirs.actor.fx, undefined, 'no effect is worn');
    for (const item of page.body.items) {
        const v = contracts.validate('feed.item@1', item);
        assert.ok(v.valid, `feed.item@1: ${JSON.stringify(v.errors)}`);
    }
    await up.close();

    // Inventory down: the feed still answers, without an effect.
    const down = await serve(inventoryDown);
    const still = await down.get('/api/v1/feed?site=community&limit=10');
    assert.strictEqual(still.status, 200, 'Inventory down never blocks the feed');
    const quiet = still.body.items.find((i) => i.id === 'f:community:paste:pic-1');
    assert.strictEqual(quiet.actor.handle, 'moosely', 'the person is still named');
    assert.strictEqual(quiet.actor.fx, undefined, 'without an effect');
    await down.close();

    // ── what a deal costs: a folded run of deals lists each offer's price ──
    const hour = new Date(now - 3 * 86400000); hour.setUTCMinutes(10, 0, 0);
    for (let i = 0; i < 3; i++) {
        await store.upsertItem(db, { source_service: 'deals', source_type: 'offer', source_id: `offer-${i}`, kind: 'deal',
            title: `Deal ${i}`, text: '', url: `https://openvibe.deals/d/${i}`, site: 'deals', site_name: 'Deals',
            origin: 'system', counts: {}, occurred_at: new Date(hour.getTime() - i * 1000).toISOString(),
            price_amount: 89.5, price_currency: 'eur', was_price: 129.5, store_name: 'Zalando' });
    }
    const deals = await serve(inventoryOk);
    const list = await deals.get('/api/v1/feed?site=deals&limit=10');
    const card = list.body.items.find((i) => i.kind === 'deal' && i.group);
    assert.ok(card, 'the run of deals is one card');
    assert.strictEqual(card.group.count, 3);
    const first = card.group.items.find((i) => i.id === 'f:deals:offer:offer-0');
    assert.deepStrictEqual(first.price, { amount: 89.5, currency: 'EUR' }, 'the price, with its currency in upper case');
    assert.strictEqual(first.was, 129.5, 'and the price it was');
    assert.strictEqual(first.store, 'Zalando', 'and the shop that sells it');
    const v = contracts.validate('feed.item@1', card);
    assert.ok(v.valid, `feed.item@1: ${JSON.stringify(v.errors)}`);
    await deals.close();

    console.log('feed: the person on the card and the price of a deal pass');
})().catch((err) => { console.error(err); process.exit(1); });
