#!/usr/bin/env node
/**
 * Every profile picture becomes the person's own avatar object (incident 2026-11-06). Before this, an avatar could
 * be another product's object — usually a Community paste screenshot — so a cleanup, a paste deletion or a private
 * re-host broke the picture. This copies each one into a native avatar object on openvibe.media, owned by the
 * person, and records the profile reference in Media so the object can no longer be deleted out from under a
 * working profile.
 *
 *   node scripts/migrate-screenshot-avatars.js                 # dry run: lists every row it would change
 *   node scripts/migrate-screenshot-avatars.js --apply         # copy, update and announce
 *   node scripts/migrate-screenshot-avatars.js --live-db <url> # also scan Live's own copies and channel banners
 *
 * What it changes, in this order:
 *   1. Network users.avatar_url — every picture is copied (or reused when it is already the person's avatar
 *      object) through the avatar service, so the profile reference is recorded; a value that is not an https
 *      picture address is cleared to the generated initial. The users trigger records each change, and drain()
 *      emits network.user.updated so every service's subject projection refreshes. The change is pushed to Live.
 *   2. Live users.avatar_url — Live's own copy of the picture (the service may not be linked to a Network account):
 *      same copy, `product live`, slot `avatar:<live user id>`. A legacy local path (/data/avatars/…, which 404s)
 *      falls back to the linked Network account's picture, or the initial.
 *   3. Live channels.offline_banner_url — a channel banner is copied with the wide `banner` shape, slot
 *      `banner:<channel id>`.
 *
 * Without --live-db steps 2 and 3 are skipped and reported as such (there is a Network account behind most Live
 * rows, and the push in step 1 already fixes those). It needs Network's DATABASE_URL, Media's internal URL and
 * Network's signing key, the way the service runs; no secret is printed.
 */
'use strict';
const { parseArgs } = require('./lib/db-ops');

const USAGE = `Move every avatar and channel banner onto the person's own avatar object.

  node scripts/migrate-screenshot-avatars.js                dry run: list every row it would change
  node scripts/migrate-screenshot-avatars.js --apply        copy, update and announce
  node scripts/migrate-screenshot-avatars.js --live-db <url> also scan Live's own copies and channel banners

Options:
  --live-db <url>  Live's PostgreSQL connection string (else LIVE_DATABASE_URL)
  --apply          write (default: dry run)
  --help           this text`;

const AVATAR_OBJECT = /^https:\/\/openvibe\.media\/o\/(med_[0-9A-HJKMNP-TV-Z]{26})$/;

/** 'copy' (an https picture to import) · 'clear' (not a picture address: the initial) */
function classify(url) {
    if (!url) return 'none';
    return /^https:\/\//i.test(String(url)) ? 'copy' : 'clear';
}

/** A site's own row can fall back to the Network account's picture; that is 'fallback', not a bare clear. */
function liveAction(url) {
    const c = classify(url);
    return c === 'clear' ? 'fallback' : c;
}

/** The Network rows this script may change: every account with a picture, whatever it points at. */
async function planNetwork(db) {
    const rows = await db.prepare('SELECT id, username, avatar_url FROM users WHERE avatar_url IS NOT NULL ORDER BY id').all();
    return rows.map((r) => ({ product: 'network', id: Number(r.id), username: r.username, before: r.avatar_url, action: classify(r.avatar_url) }));
}

/** Live's own copies and banners, with the Network account each row is linked to (if any). */
async function planLive(live) {
    const [users, banners] = await Promise.all([live.users(), live.banners()]);
    const out = [];
    for (const u of users) {
        const action = liveAction(u.avatar_url);
        out.push({ product: 'live', slot: `avatar:${u.id}`, id: Number(u.id), username: u.username,
            before: u.avatar_url, action, networkUserId: u.network_user_id == null ? null : Number(u.network_user_id) });
    }
    for (const c of banners) {
        out.push({ product: 'live', slot: `banner:${c.id}`, id: Number(c.id), channelId: Number(c.id), before: c.offline_banner_url,
            action: liveAction(c.offline_banner_url), shape: 'banner',
            networkUserId: c.network_user_id == null ? null : Number(c.network_user_id) });
    }
    return out;
}

/** What a plan row will become, in one line: the dry run is this listing. */
function describe(p) {
    const where = p.product === 'network' ? `network users.avatar_url id=${p.id}` : `live ${p.slot}`;
    if (p.action === 'none') return `${where}  unchanged`;
    if (p.action === 'copy') return `${where}  copy ${p.before}`;
    if (p.action === 'fallback') return `${where}  legacy local path ${p.before} → ${p.to || 'the initial'}`;
    return `${where}  not a picture address ${p.before} → the initial`;
}

function liveAdapter(client) {
    return {
        users: async () => (await client.query(
            `SELECT u.id, u.username, u.avatar_url, la.service_user_id AS network_user_id
               FROM users u LEFT JOIN linked_accounts la ON la.service = 'network' AND la.user_id = u.id
              WHERE u.avatar_url IS NOT NULL ORDER BY u.id`)).rows,
        banners: async () => (await client.query(
            `SELECT c.id, c.offline_banner_url, la.service_user_id AS network_user_id
               FROM channels c LEFT JOIN linked_accounts la ON la.service = 'network' AND la.user_id = c.user_id
              WHERE c.offline_banner_url IS NOT NULL ORDER BY c.id`)).rows,
        setUserAvatar: async (id, url) => await client.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [url, id]),
        setBanner: async (id, url) => await client.query('UPDATE channels SET offline_banner_url = $1 WHERE id = $2', [url, id]),
    };
}

function createExecutor({ db, config, selfToken, live = null }) {
    const media = () => ((config.services && config.services.media && config.services.media.internalUrl) || 'http://127.0.0.1:4100').replace(/\/$/, '');
    async function mediaCall(path, cap, body) {
        const token = selfToken && selfToken('openvibe.media', [cap]);
        if (!token) throw new Error('Media signing key is not configured (JWT_PRIVATE_KEY)');
        const r = await fetch(`${media()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.ok === false) throw new Error(`${path}: ${j.error || `HTTP ${r.status}`}`);
        return j;
    }
    return {
        mediaCall,
        /** Step 1: the avatar service copies + records + applies + pushes (the same path the profile form uses). */
        async network(p) {
            const svc = require('../server/profile/avatar').createAvatarService({
                db, config, requireAuth: (_q, _s, n) => n(), selfToken,
            });
            if (p.action === 'copy') {
                const r = await svc.fromSite({ user_id: p.id, avatar_url: p.before, origin: 'network' });
                if (r.status !== 200) throw new Error(r.error || `HTTP ${r.status}`);
                return r.changed ? 'copied' : 'already its own avatar object';
            }
            await svc.apply(p.id, p.username, null, 'network');
            await svc.release(p.id);
            return 'cleared to the initial';
        },
        /** Step 2/3: Live's own rows, through Media's ingest (the service is not the caller here). */
        async liveCopy(p, subject) {
            const j = await mediaCall('/internal/avatar-ingest', 'media.avatar.ingest', {
                url: p.before, user_id: p.id, username: p.username || null, subject, product: 'live', ref: p.slot,
                ...(p.shape ? { shape: p.shape } : {}),
            });
            const url = j.url;
            if (p.shape === 'banner') await live.setBanner(p.channelId, url); else await live.setUserAvatar(p.id, url);
            if (j.reused) return { result: 'already its own avatar object', url };
            return { result: 'copied', url };
        },
        /** A legacy local path: point Live at the linked Network picture, or the initial. */
        async liveFallback(p, networkAvatar) {
            if (networkAvatar) {
                const m = AVATAR_OBJECT.exec(networkAvatar);
                if (m) await mediaCall('/internal/avatar-adopt', 'media.avatar.adopt', { object_id: m[1], product: 'live', ref: p.slot });
            }
            if (p.shape === 'banner') await live.setBanner(p.channelId, networkAvatar || null); else await live.setUserAvatar(p.id, networkAvatar || null);
            return { result: networkAvatar ? 'the linked Network picture' : 'the initial', url: networkAvatar || null };
        },
    };
}

async function main(argv = process.argv.slice(2), { db: injected, live: injectedLive, log = console } = {}) {
    const args = parseArgs(argv, { flags: ['apply', 'help'], values: ['live-db'] });
    if (args.help) { log.log(USAGE); return 0; }

    let db = injected;
    if (!db) {
        if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set: run this where Network runs (or point it at a copy)');
        db = await require('openvibe-sdk/db').createDb({ url: process.env.DATABASE_URL, service: 'network-avatar-migration', max: 2 });
    }
    let live = injectedLive || null;
    let closeLive = null;
    const liveUrl = args['live-db'] || process.env.LIVE_DATABASE_URL;
    if (!live && liveUrl) {
        const { Client } = require('pg');
        const client = new Client({ connectionString: liveUrl });
        await client.connect();
        live = liveAdapter(client);
        closeLive = async () => await client.end();
    }

    try {
        const network = await planNetwork(db);
        const livePlans = live ? await planLive(live) : [];
        const todo = [...network, ...livePlans].filter((p) => p.action !== 'none');

        if (!args.apply) {
            for (const p of todo) log.log(describe(p));
            const count = (list, product) => list.filter((p) => p.product === product && p.action !== 'none').length;
            log.log(`dry run: ${count(network, 'network')} Network avatar(s), ${live ? count(livePlans, 'live') : 0} Live picture(s)/banner(s)`);
            if (!live) log.log('Live was not scanned (no --live-db / LIVE_DATABASE_URL); its linked accounts are still fixed by the push in step 1.');
            log.log('Nothing changed. Re-run with --apply to copy them into avatar objects.');
            return 0;
        }

        const config = require('../server/config');
        const keyPath = process.env.JWT_PRIVATE_KEY || config.jwt.privateKeyPath;
        const privateKey = (() => { try { return require('fs').readFileSync(keyPath, 'utf8'); } catch { return null; } })();
        const selfToken = require('../server/identity/self-token').createSelfTokens({ privateKey, issuer: config.jwt.issuer });
        const exec = createExecutor({ db, config, selfToken, live });

        const failures = [];
        let changed = 0;
        for (const p of network) {
            if (p.action === 'none') continue;
            try { const result = await exec.network(p); changed++; log.log(`${describe(p)} → ${result}`); }
            catch (err) { failures.push(`network ${p.id}: ${err.message}`); log.error(`network users.avatar_url id=${p.id} failed: ${err.message}`); }
        }

        // The trigger queued each change; drain() turns it into network.user.updated for every service.
        if (changed) {
            try {
                const queue = require('../server/identity/profile-events');
                await queue.ensureSchema(db);
                const n = await queue.drain(db);
                log.log(`announced ${n} profile update(s) (network.user.updated)`);
            } catch (err) { failures.push(`profile events: ${err.message}`); log.error(`profile events failed: ${err.message}`); }
        }

        if (live) {
            // Read Network's pictures as they are now: a legacy Live row falls back to what Network holds, and a Live
            // row the push already fixed is read as it is rather than copied a second time from its old source.
            const now = new Map((await db.prepare('SELECT id, subject_id, avatar_url FROM users').all()).map((u) => [Number(u.id), u]));
            for (const p of await planLive(live)) {
                if (p.action === 'none') continue;
                const account = p.networkUserId != null ? now.get(p.networkUserId) : null;
                const subject = account && account.subject_id ? account.subject_id : null;
                try {
                    if (p.action === 'copy') {
                        const out = await exec.liveCopy(p, subject);
                        log.log(`${describe(p)} → ${out.result}${out.url ? ` (${out.url})` : ''}`);
                    } else {
                        const out = await exec.liveFallback(p, account ? account.avatar_url : null);
                        log.log(`${describe({ ...p, action: 'fallback', to: out.url }) } → ${out.result}`);
                    }
                    changed++;
                } catch (err) { failures.push(`live ${p.slot}: ${err.message}`); log.error(`live ${p.slot} failed: ${err.message}`); }
            }
        } else {
            log.log('Live was not scanned (no --live-db / LIVE_DATABASE_URL); its linked accounts were fixed by the push.');
        }

        log.log(`done: ${changed} row(s) changed${failures.length ? `, ${failures.length} failed` : ''}`);
        return failures.length ? 1 : 0;
    } finally {
        if (closeLive) await closeLive();
    }
}

module.exports = { main, classify, planNetwork, planLive, describe, liveAdapter };

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((err) => { console.error(err.message); process.exit(2); });
}
