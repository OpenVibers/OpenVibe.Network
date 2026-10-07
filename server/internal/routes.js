'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.network — Internal Server-to-Server API (loopback only)
// First-party services resolve identities, move OpenCoins, push notifications and read
// shared data here. Every route checks the one capability it performs on a service token
// (identity/principals.js guard), and nothing else is accepted.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const urlRegistry = require('../url-registry');
const wallet = require('../coins/wallet');

function getDb(req) { return req.app.locals.db; }
function getConfig(req) { return req.app.locals.config; }

// ── The gate ────────────────────────────────────────────────
// Every route below checks the one capability it performs on a service token (principals.guard); nothing
// else gets in.
function requireServiceToken(req, res, next) {
    // Express mounts are case-insensitive, nginx locations are not: /INTERNAL/... would skip the
    // proxy's loopback-only `location /internal/` rule. Only the exact spelling is served.
    if (req.baseUrl !== '/internal') return res.status(404).json({ error: 'Not found' });
    if (!String(req.headers.authorization || '').startsWith('Bearer ')) {
        return require('openvibe-contracts').http.sendProblem(res, 401, 'token.missing', { detail: 'a service token is required' });
    }
    return next();
}
const principals = require('../identity/principals');
const forApp = (req) => (req.body && req.body.app_id !== undefined ? String(req.body.app_id) : undefined);
const forService = (req) => (req.body && req.body.service !== undefined ? String(req.body.service) : undefined);

// A service token may only map ids of its own system (svc:live -> source_system 'live').
function ownSourceSystem(req, res, next) {
    const p = req.principal;
    if (!p) return require('openvibe-contracts').http.sendProblem(res, 401, 'token.missing', { detail: 'a service token is required' });
    const self = String(p.sub).replace(/^svc:/, '');
    const entries = req.body && Array.isArray(req.body.entries) ? req.body.entries : [];
    if (entries.some(e => !e || String(e.source_system) !== self)) {
        return require('openvibe-contracts').http.sendProblem(res, 403, 'capability.owner_denied', { detail: `${p.sub} may only map ids whose source_system is '${self}'` });
    }
    next();
}

router.use(requireServiceToken);
// Identity lookups accept a service token with identity.subject.resolve (or the key, as before).
router.get('/identity/resolve', principals.guard('identity.subject.resolve'));
router.post('/identity/resolve-batch', principals.guard('identity.subject.resolve'));
// Writing the legacy map is part of identity resolution (ADR-001; identity.subject.resolve takes
// identity.legacy-identity-map@1). TODO(contracts): a narrower identity.legacy_map.write capability.
router.post('/identity/legacy-map', principals.guard('identity.subject.resolve'), ownSourceSystem);
router.use('/identity', require('../identity/internal-routes'));

// ── Sync Linked Account ──────────────────────────────────────
// When a user connects their OpenVibe.Live or OpenVibe.Games account,
// the service reports the link here.
// A service token may only report links for its own service (svc:live -> service 'live').
router.post('/link-account', principals.guard('identity.subject.resolve', { ownApp: forService }), async (req, res) => {
    const { user_id, service, service_user_id, service_username, avatar_url, display_name } = req.body;
    if (!user_id || !service || !service_user_id) {
        return res.status(400).json({ error: 'user_id, service, and service_user_id required' });
    }

    const db = await getDb(req);
    await db.prepare(`
        INSERT INTO linked_accounts (user_id, service, service_user_id, service_username, linked_at)
        VALUES (?, ?, ?, ?, ov_now())
        ON CONFLICT(user_id, service) DO UPDATE SET
            service_user_id = ?,
            service_username = ?,
            linked_at = ov_now()
    `).run(user_id, service, service_user_id, service_username || null, service_user_id, service_username || null);

    // The site told us its own id for this account: record it against the canonical subject too, so
    // other services can resolve "<service> user N" without asking that site (Wave 1 legacy map).
    if (!String(service_user_id).startsWith('network:')) {
        try {
            const r = await require('../identity/subjects').upsertLegacy(db, [{ network_user_id: user_id, source_system: String(service), source_type: 'user', source_id: String(service_user_id), verified: true }]);
            if (r.conflicts.length) console.warn(`[Identity] ${service} user ${service_user_id} is already mapped to another subject; not repointed`);
        } catch (err) { console.warn('[Identity] legacy map from link-account failed:', err.message); }
    }

    // People set their picture on the site they use (usually Live). When the network account has none, adopt it,
    // so every other site shows the same face. Never overwrites a picture or name the user set here, and only
    // accepts https URLs on our own sites.
    try {
        const me = await db.prepare('SELECT avatar_url, display_name, username FROM users WHERE id = ?').get(user_id);
        if (me) {
            const svc = req.app.locals.avatarService;
            if (svc && avatar_url && !me.avatar_url) await svc.fromSite({ user_id, avatar_url, origin: service });
            const name = String(display_name || '').trim().slice(0, 60);
            // Same rule the profile form enforces: a display name only re-cases the username.
            if (name && name !== me.display_name && name.toLowerCase() === String(me.username || '').toLowerCase()) await db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, user_id);
        }
    } catch (err) { console.warn('[Internal] profile adopt failed:', err.message); }

    res.json({ success: true });
});

// ── A site changed someone's avatar (Live's avatar picker) ───
router.post('/user-avatar', principals.guard('network.avatar.write'), async (req, res) => {
    const svc = req.app.locals.avatarService;
    if (!svc) return res.status(503).json({ error: 'avatar service unavailable' });
    const r = await svc.fromSite(req.body || {});
    res.status(r.status).json(r.error ? { error: r.error } : { ok: true, changed: r.changed });
});

// Service URLs only (no secrets). Secret-typed entries (DEPLOY_CLOUDFLARE_TOKEN) are left out: they are the
// owner's, not the services'.
router.get('/url-registry/resolved', principals.guard('network.registry.read'), async (req, res) => {
    try {
        const db = await getDb(req);
        const { URL_DEFINITIONS } = require('openvibe-shared/url-resolver');
        const { isSensitiveSettingKey } = require('../auth/owner-guard');
        const resolved = Object.fromEntries(Object.entries(await urlRegistry.getResolvedRegistry(db, process.env))
            .filter(([key]) => !((URL_DEFINITIONS[key] || {}).type === 'secret' || isSensitiveSettingKey(key))));
        res.json({ ok: true, registry: resolved });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// OpenCoins Wallet (server-to-server)
// Atomic better-sqlite3 transactions with idempotency_key dedupe.
// Repeating a key returns the original result (no double-apply).
// user_id is ALWAYS the Network (SSO) user id.
// ═══════════════════════════════════════════════════════════════

function handleWalletError(res, err) {
    if (err instanceof wallet.WalletError) {
        return res.status(err.status).json(err.body);
    }
    console.error('[Internal] Wallet error:', err);
    return res.status(500).json({ error: 'wallet_internal_error' });
}

// ── GET /internal/coins/stats ────────────────────────────────
// Site-wide OpenCoins totals for public stat displays (OpenVibe.Live's home hero).
// Summing the whole ledger is cheap at our size but pointless to repeat per pageview,
// so the answer is held for a minute.
let _coinStats = { at: 0, data: null };
// Guarded by the ledger capability its caller (Live's home hero) holds. TODO(contracts): network.coins.read.
router.get('/coins/stats', principals.guard('network.coins.read'), async (req, res) => {
    try {
        if (_coinStats.data && Date.now() - _coinStats.at < 60_000) return res.json(_coinStats.data);
        const db = await getDb(req);
        const one = async (sql) => { try { const row = await db.prepare(sql).get(); return Number(row?.n ?? 0); } catch { return 0; } };
        const data = {
            earned: await one('SELECT COALESCE(SUM(delta), 0) AS n FROM coin_transactions WHERE delta > 0'),
            spent: await one('SELECT COALESCE(-SUM(delta), 0) AS n FROM coin_transactions WHERE delta < 0'),
            circulating: await one('SELECT COALESCE(SUM(balance), 0) AS n FROM wallets'),
            holders: await one('SELECT COUNT(*) AS n FROM wallets WHERE balance > 0'),
            transactions: await one('SELECT COUNT(*) AS n FROM coin_transactions'),
            // Rolling windows so the display can say whether the economy is speeding up. Same
            // shape the Live stats use: this seven days, and the seven before it.
            recent: {
                earned: {
                    w: await one("SELECT COALESCE(SUM(delta), 0) AS n FROM coin_transactions WHERE delta > 0 AND created_at >= datetime('now','-7 days')"),
                    pw: await one("SELECT COALESCE(SUM(delta), 0) AS n FROM coin_transactions WHERE delta > 0 AND created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days')"),
                },
                spent: {
                    w: await one("SELECT COALESCE(-SUM(delta), 0) AS n FROM coin_transactions WHERE delta < 0 AND created_at >= datetime('now','-7 days')"),
                    pw: await one("SELECT COALESCE(-SUM(delta), 0) AS n FROM coin_transactions WHERE delta < 0 AND created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days')"),
                },
                holders: {
                    w: await one("SELECT COUNT(DISTINCT user_id) AS n FROM coin_transactions WHERE created_at >= datetime('now','-7 days')"),
                    pw: await one("SELECT COUNT(DISTINCT user_id) AS n FROM coin_transactions WHERE created_at >= datetime('now','-14 days') AND created_at < datetime('now','-7 days')"),
                },
            },
        };
        _coinStats = { at: Date.now(), data };
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: String(err.message || err) });
    }
});

// ── POST /internal/coins/credit ──────────────────────────────
// Body: { user_id, app_id, amount (positive int), reason, ref?, idempotency_key }
// → { balance }
// User modules for services (token only; server/identity/modules.js).
require('../identity/modules').serviceRoutes(router, principals);

router.post('/coins/credit', principals.guard('network.coins.credit', { ownApp: forApp }), async (req, res) => {
    try {
        const { user_id, app_id, amount, reason, ref, idempotency_key } = req.body || {};
        const result = await wallet.credit(await getDb(req), { user_id, app_id, amount, reason, ref, idempotency_key });
        res.json({ balance: result.balance });
    } catch (err) {
        handleWalletError(res, err);
    }
});

// ── POST /internal/coins/debit ───────────────────────────────
// Same body → { balance }; insufficient funds → 409 { error: 'insufficient_funds', balance }
router.post('/coins/debit', principals.guard('network.coins.debit', { ownApp: forApp }), async (req, res) => {
    try {
        const { user_id, app_id, amount, reason, ref, idempotency_key } = req.body || {};
        const result = await wallet.debit(await getDb(req), { user_id, app_id, amount, reason, ref, idempotency_key });
        res.json({ balance: result.balance });
    } catch (err) {
        handleWalletError(res, err);
    }
});

// ── POST /internal/coins/transfer ────────────────────────────
// Body: { from_user_id, to_user_id, app_id, amount, reason, ref?, idempotency_key }
// → { from_balance, to_balance } (atomic)
router.post('/coins/transfer', principals.guard('network.coins.transfer', { ownApp: forApp }), async (req, res) => {
    try {
        const { from_user_id, to_user_id, app_id, amount, reason, ref, idempotency_key } = req.body || {};
        const result = await wallet.transfer(await getDb(req), { from_user_id, to_user_id, app_id, amount, reason, ref, idempotency_key });
        res.json({ from_balance: result.from_balance, to_balance: result.to_balance });
    } catch (err) {
        handleWalletError(res, err);
    }
});

// ═══════════════════════════════════════════════════════
// Stream-Live Event Handler
// OpenVibe.Live calls this when a stream goes live.
// Handles: Discord alerts (via bot), push notifications to
// followers + "all streamer" subscribers.
// ═══════════════════════════════════════════════════════════════

const streamLive = require('../notifications/stream-live');
router.post('/events/stream-live', principals.guard('network.notifications.push'), async (req, res) => {
    const { streamer, stream, follower_network_ids } = req.body;
    if (!streamer?.username || !stream?.id) {
        return res.status(400).json({ error: 'streamer and stream objects required' });
    }

    const results = { discord: null, notifications: null };

    // ── Per-streamer rate limit (persisted — survives deploys) ───────────────────
    // A streamer flapping off/on (reconnects, restarts, OBS hiccups) must not re-announce
    // every time. One fan-out per streamer per `stream_live_cooldown_min` (default 60) and
    // at most `stream_live_daily_cap` (default 8) per rolling 24h — gating inbox, push,
    // email AND Discord. `force:true` (admin/manual) bypasses the cooldown, not the cap.
    // The same window is claimed by the live.stream.started consumer (../notifications/stream-live.js).
    {
        const claim = await streamLive.claimAnnouncement(await getDb(req), { streamerKey: streamer.network_id || streamer.id || streamer.username, streamId: stream.id, force: !!req.body.force });
        if (claim.skipped && claim.reason === 'daily-cap') {
            console.log(`[StreamLive] ${streamer.username}: daily cap (${claim.cap}) reached — not announcing`);
            return res.json({ ok: true, ...claim });
        }
        if (claim.skipped) {
            console.log(`[StreamLive] ${streamer.username}: cooling down until ${claim.next_allowed_at}`);
            return res.json({ ok: true, ...claim });
        }
    }

    // ── Discord Alert ────────────────────────────────────────
    const discordService = req.app.locals.discordService;
    if (discordService) {
        try {
            results.discord = await discordService.sendLiveAlert(streamer, stream);
        } catch (err) {
            results.discord = { sent: false, reason: 'error', error: err.message };
        }
    }

    // ── Push Notifications to Followers ──────────────────────
    const notifService = req.app.locals.notificationService;
    if (notifService) {
        const db = await getDb(req);
        const notifData = streamLive.streamLiveNotification({
            username: streamer.username, displayName: streamer.display_name, avatarUrl: streamer.avatar_url,
            senderId: streamer.id || null, stream, url: streamLive.channelUrl(streamer.username),
        });

        // The streaming follow graph lives in OpenVibe.Live, keyed by LIVE user ids; Live
        // translates its followers to NETWORK ids via linked_accounts and sends them here.
        // (Network's own `follows` table is a separate, tiny social graph and `streamer.id`
        // is a Live id — the old lookup below silently addressed the wrong accounts.)
        let followerIds = Array.isArray(follower_network_ids)
            ? follower_network_ids.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 20000)
            : [];
        if (!Array.isArray(follower_network_ids)) {
            // Legacy caller: fall back to Network's graph, resolving the streamer's NETWORK id first.
            const link = streamer.id ? await db.prepare("SELECT user_id FROM linked_accounts WHERE service = 'live' AND service_user_id = ?").get(String(streamer.id)) : null;
            if (link) followerIds = (await db.prepare('SELECT follower_id FROM follows WHERE followed_id = ?').all(link.user_id)).map(r => r.follower_id);
        }
        // sender_id must be the streamer's NETWORK id for dedupe + "who is this" lookups.
        try {
            const link = streamer.id ? await db.prepare("SELECT user_id FROM linked_accounts WHERE service = 'live' AND service_user_id = ?").get(String(streamer.id)) : null;
            if (link) notifData.sender_id = link.user_id;
            // A Live id is not a Network person: no block check against whoever has that Network id.
            else notifData.actor_subject = null;
        } catch { notifData.actor_subject = null; /* keep Live id */ }

        // Find users who opted into "all live" notifications
        const allLiveUserIds = await streamLive.allLiveSubscribers(db);

        // Merge and deduplicate
        const targetIds = [...new Set([...followerIds, ...allLiveUserIds])];

        if (targetIds.length > 0) {
            try {
                const created = await notifService.createBulk(targetIds, notifData);
                results.notifications = { sent: created.length, total: targetIds.length };
            } catch (err) {
                results.notifications = { error: err.message };
            }
        } else {
            results.notifications = { sent: 0, total: 0 };
        }
    }

    res.json({ ok: true, ...results });
});

// ═══════════════════════════════════════════════════════════════
// Cross-Service Notification Push
// Services call these to create notifications for users without
// needing direct DB access.
// ═══════════════════════════════════════════════════════════════

// ── Push Single Notification ─────────────────────────────────
// POST /internal/notifications/push
// Body: { user_id, type, title, message, icon, sender_id, sender_name, sender_avatar, service, url, priority, category, rich_content, expires_at }
router.post('/notifications/push', principals.guard('network.notifications.push', { ownApp: forService }), async (req, res) => {
    const notifService = req.app.locals.notificationService;
    if (!notifService) return res.status(503).json({ error: 'Notification service unavailable' });

    const { user_id, ...data } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    try {
        const notification = await notifService.create({ user_id, ...data });
        if (!notification) return res.json({ ok: true, skipped: true, reason: 'User has category disabled' });
        res.json({ ok: true, notification });
    } catch (err) {
        console.error('[Internal] Notification push error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Push Bulk Notifications ──────────────────────────────────
// POST /internal/notifications/push-bulk
// Body: { user_ids: [], type, title, message, ... }
router.post('/notifications/push-bulk', principals.guard('network.notifications.push', { ownApp: forService }), async (req, res) => {
    const notifService = req.app.locals.notificationService;
    if (!notifService) return res.status(503).json({ error: 'Notification service unavailable' });

    const { user_ids, ...data } = req.body;
    if (!Array.isArray(user_ids) || user_ids.length === 0) {
        return res.status(400).json({ error: 'user_ids array required' });
    }
    if (user_ids.length > 1000) {
        return res.status(400).json({ error: 'Max 1000 user_ids per request' });
    }

    try {
        const results = await notifService.createBulk(user_ids, data);
        res.json({ ok: true, sent: results.length, total: user_ids.length });
    } catch (err) {
        console.error('[Internal] Bulk notification push error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Operator alerts (roadmap WS-H task 11) ───────────────────
// POST /internal/operator/alerts — network.operator-alerts-request@1 → network.operator-alerts-result@1.
// Host's relay (ovhost alerts relay) sends the complete set of alerts firing now; server/operator/alerts.js
// pages the owner when one opens, once a day while it stays open, and when it resolves. Token only.
router.post('/operator/alerts', principals.guard('network.operator.alert'), async (req, res) => {
    const contracts = require('openvibe-contracts');
    const v = contracts.validate('network.operator-alerts-request@1', req.body);
    if (!v.valid) return res.status(400).json({ error: 'The body does not match network.operator-alerts-request@1', details: (v.errors || []).slice(0, 5) });
    const notifService = req.app.locals.notificationService;
    const notify = notifService ? (userId, n) => notifService.create({ user_id: userId, ...n }) : null;
    const revise = notifService ? (userId, id, fields) => notifService.revise(id, userId, fields) : null;
    try {
        res.json(await require('../operator/alerts').receive(await getDb(req), req.body, { notify, revise }));
    } catch (err) {
        console.error('[Internal] Operator alerts error:', err.message);
        res.status(500).json({ error: 'Operator alerts failed' });
    }
});

// ── Mark Notifications Read by Type ──────────────────────────
// POST /internal/notifications/mark-read
// Body: { user_id, type, url_pattern? }
router.post('/notifications/mark-read', principals.guard('network.notifications.push'), async (req, res) => {
    const notifService = req.app.locals.notificationService;
    if (!notifService) return res.status(503).json({ error: 'Notification service unavailable' });

    const { user_id, type, url_pattern } = req.body;
    if (!user_id || !type) return res.status(400).json({ error: 'user_id and type required' });

    try {
        const changes = await notifService.markReadByType(parseInt(user_id), type, url_pattern || null);
        res.json({ ok: true, marked: changes });
    } catch (err) {
        console.error('[Internal] Mark read by type error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// Unified Anon Identity Resolution (cross-service)
// ═══════════════════════════════════════════════════════════════

// ── Resolve Anon by IP ───────────────────────────────────────
// POST /internal/resolve-anon
// Body: { ip }
// Called by first-party services to get or create a unified
// anon identity for a given IP address. Single source of truth.
router.post('/resolve-anon', principals.guard('identity.subject.resolve'), async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'ip required' });

    const db = await getDb(req);
    const { v4: uuidv4 } = require('uuid');

    try {
        // Check if this IP already has an anon
        const byIpLog = await db.prepare(`
            SELECT a.* FROM anon_users a
            INNER JOIN anon_ip_log l ON l.anon_id = a.id
            WHERE l.ip = ?
            ORDER BY a.id ASC LIMIT 1
        `).get(ip);
        if (byIpLog) {
            await db.prepare('UPDATE anon_users SET last_seen = ov_now() WHERE id = ?').run(byIpLog.id);
            await db.prepare(`
                UPDATE anon_ip_log SET last_seen = ov_now()
                WHERE anon_id = ? AND ip = ?
            `).run(byIpLog.id, ip);
            return res.json({
                anon_number: byIpLog.anon_number,
                anon_id: `anon_${byIpLog.id}`,
                display_name: byIpLog.display_name || `Anonymous #${byIpLog.anon_number}`,
                username: `anon${byIpLog.anon_number}`,
                is_new: false,
            });
        }

        // Check by creating IP
        const byCreatingIp = await db.prepare('SELECT * FROM anon_users WHERE ip = ? ORDER BY id ASC LIMIT 1').get(ip);
        if (byCreatingIp) {
            await db.prepare('UPDATE anon_users SET last_seen = ov_now() WHERE id = ?').run(byCreatingIp.id);
            // Ensure IP log entry exists
            try {
                await db.prepare('INSERT INTO anon_ip_log (anon_id, ip) VALUES(?, ?) ON CONFLICT DO NOTHING').run(byCreatingIp.id, ip);
            } catch { /* ok */ }
            return res.json({
                anon_number: byCreatingIp.anon_number,
                anon_id: `anon_${byCreatingIp.id}`,
                display_name: byCreatingIp.display_name || `Anonymous #${byCreatingIp.anon_number}`,
                username: `anon${byCreatingIp.anon_number}`,
                is_new: false,
            });
        }

        // Create new anon
        const maxNum = (await db.prepare('SELECT MAX(anon_number) as max FROM anon_users').get()).max || 0;
        const anonNumber = maxNum + 1;
        const sessionToken = uuidv4();

        const result = await db.prepare(
            'INSERT INTO anon_users (anon_number, session_token, ip, subject_id) VALUES (?, ?, ?, ?) RETURNING id'
        ).run(anonNumber, sessionToken, ip, require('../identity/subjects').newGuestSubjectId());

        // Log IP
        try {
            await db.prepare('INSERT INTO anon_ip_log (anon_id, ip) VALUES (?, ?)').run(result.lastInsertRowid, ip);
        } catch { /* ok */ }

        console.log(`[Internal] New unified anon #${anonNumber} for IP ${ip}`);
        res.json({
            anon_number: anonNumber,
            anon_id: `anon_${result.lastInsertRowid}`,
            display_name: `Anonymous #${anonNumber}`,
            username: `anon${anonNumber}`,
            is_new: true,
        });
    } catch (err) {
        console.error('[Internal] resolve-anon error:', err);
        res.status(500).json({ error: 'Failed to resolve anon identity' });
    }
});

// ── Read a developer project ─────────────────────────────────
// Owning services key tenancy by project_id and enforce the quotas Network records (docs/developer-projects.md, ADR-014).
// The capability is first-party and never grantable to apps; the view carries no secrets and no members but the owner.
router.get('/projects/:project_id', principals.guard('network.project.read'), async (req, res) => {
    try {
        const out = await require('../developer/store').internalProjectView(getDb(req), req.params.project_id);
        if (!out) return require('openvibe-contracts').http.sendProblem(res, 404, 'project.not_found', { detail: 'no such project' });
        res.set('Cache-Control', 'no-store').json(out);
    } catch (err) {
        console.error('[Internal] project read error:', err.message);
        require('openvibe-contracts').http.sendProblem(res, 500, 'internal.error', { detail: 'project read failed' });
    }
});

// ── Read an agent ────────────────────────────────────────────
// Set before the guard so its refusals are not cached either.
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
// The owning service enforces an agent's delegated grants and budgets (plan T2 WS-Z2 slice 6,
// docs/t2-projects-and-grants.md section 4): only the grants at the caller's own audience, never another's.
router.get('/agents/:agent', noStore, principals.guard('network.project.read'), async (req, res) => {
    try {
        const audience = `openvibe.${String(req.principal.sub).replace(/^svc:/, '')}`;
        const out = await require('../developer/agents').internalAgentView(getDb(req), req.params.agent, audience);
        if (!out) return require('openvibe-contracts').http.sendProblem(res, 404, 'agent.not_found', { detail: 'no such agent' });
        res.json(out);
    } catch (err) {
        console.error('[Internal] agent read error:', err.message);
        require('openvibe-contracts').http.sendProblem(res, 500, 'internal.error', { detail: 'agent read failed' });
    }
});

// ── Confirmations, the owning service's side ─────────────────
// Ask an agent's owner to confirm one sensitive action and spend the approval once (slice 7,
// server/developer/confirmations.js). Each service sees only the confirmations it created.
router.use('/confirmations', noStore, principals.guard('network.confirmation.manage'), require('../developer/confirmations').internalRouter());

module.exports = router;
