'use strict';
/**
 * OpenVibe.Events → notifications: POST /internal/events, the endpoint of Network's Events
 * subscriptions (consumer `network`, created by scripts/subscribe-events.js).
 *
 *   deals.watch.matched     a Deals watch (keyword, product, price below) matched a fresh observation;
 *                           payload.recipient is the watcher's usr_ subject
 *   trade.alert.triggered   a Trade alert rule fired (threshold crossed, filing/document seen);
 *                           event.subject { type: 'user', id } is the rule's owner
 *   live.stream.started     a Live channel went live (OpenVibe.Live server/events/stream-events.js);
 *                           payload.channel.subject is the streamer. Every follower is notified
 *                           (STREAM_LIVE, category 'stream'), plus everyone who opted into all go-lives
 *                           (stream_live_all), and the Discord live alert is sent once it has committed.
 *
 * Followers of a Live channel live in Live's database. Before the inbox transaction, Network reads
 * them from Live's GET /internal/followers with its own service token (./live-followers.js); if Live
 * cannot answer, the delivery is answered 503 and Events retries. The announcement window (one per
 * streamer per hour, eight a day) is the same one Live's direct POST /internal/events/stream-live
 * claims (./stream-live.js), so both paths can run during the switch without double notifications.
 * A started event older than LIVE_STARTED_MAX_AGE (30 min; a replay, or Events catching up after an
 * outage) announces nothing: the stream may be long over.
 *
 * Coupons publishes no watch event: its merchant watches never leave Coupons (server/domain/watches.js
 * there: "Delivery is not built yet"), and its coupons.* events name no person, so there is nothing
 * of Coupons' to consume yet. README "Notifications from Events" has the operator steps.
 *
 * Each event becomes one inbox notification for its person through NotificationService.create(),
 * which applies their preferences: a muted category ('service') creates nothing, and email follows
 * the same per-category choice (shouldEmail). Exactly once: the openvibe-sdk inbox claims
 * (consumer, event_id) in the same SQLite transaction as the notification, so a redelivery does
 * nothing and a failure rolls both back (Events retries).
 *
 * Signature: v2 only (openvibe-sdk parseDelivery with requireV2) — HMAC over "<t>.<raw body>" with t
 * within ±300 s, under NETWORK_EVENTS_SECRET (comma-separated for rotation, each 32+ characters).
 * A v1-only, stale or unsigned delivery is refused. Unset secret = 503: the route is inert until the
 * operator sets it and creates the subscriptions.
 *
 * Links: a notification links to the event's URL only when that host is one of our sites whose
 * public domain serves the service (server/frame/sites.js, via the exposure overlay). Today Deals
 * and Trade are loopback-only and their domains show placeholder pages, so the link is kept in
 * rich_content.context.planned_url and the notification has no click-through yet.
 */
const express = require('express');
const { http, ids } = require('openvibe-contracts');
const { parseDelivery, createInbox } = require('openvibe-sdk/events');
const { siteForHost } = require('../frame/sites');
const streamLive = require('./stream-live');
const { LiveFollowersError } = require('./live-followers');

const CONSUMER = 'network-notifications';
const INBOX_TABLE = 'network_event_inbox';
const AUDIT_TOPICS = require('../admin/moderation-audit').TOPICS;
const TOPICS = Object.freeze(['deals.watch.matched', 'trade.alert.triggered', 'live.stream.started', ...AUDIT_TOPICS]);
const LIVE_STARTED_MAX_AGE_MS = 30 * 60 * 1000;
const EVENT_ID_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Plain, single-line, length-capped text: no markup or control characters reach the inbox. */
function clean(v, n) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

/** An https URL on one of our sites (any, or only those whose domain serves the service), or null. */
function ownLink(u, { publicOnly = false } = {}) {
    let url;
    try { url = new URL(String(u || '')); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const site = siteForHost(url.hostname);
    if (!site || (publicOnly && site.status !== 'open')) return null;
    return url.toString().slice(0, 500);
}
const publicLink = (u) => ownLink(u, { publicOnly: true });

function secretsFrom(value) {
    return String(value || '').split(',').map((s) => s.trim()).filter((s) => s.length >= 32);
}

/** What each event type turns into. Returns { subject, notification } or an 'ignored:*' outcome. */
const HANDLERS = {
    'deals.watch.matched'(event) {
        if (event.source !== 'deals') return 'ignored:source';
        const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const title = clean(p.title, 160);
        if (!title || !p.watch_id) return 'ignored:payload';
        const obs = p.observation && typeof p.observation === 'object' ? p.observation : {};
        const price = obs.price ? `${clean(obs.price, 20)}${obs.currency ? ' ' + clean(obs.currency, 3) : ''}` : null;
        let why = '';
        if (p.kind === 'price_below' && p.max_price) why = ` (below your ${clean(p.max_price, 20)} ${clean(p.currency, 3)})`;
        else if (p.kind === 'keyword' && p.query) why = ` (matches "${clean(p.query, 80)}")`;
        return {
            subject: p.recipient,
            notification: {
                type: 'DEAL_WATCH_MATCH', category: 'service', priority: 'normal', icon: '🏷️', title: 'Deal watch matched',
                message: clean(`${title}${price ? ' at ' + price : ''}${why}`, 300),
                service: 'deals', url: publicLink(p.offer_url),
                rich_content: { service: 'deals', context: { event_id: event.event_id, watch_id: clean(p.watch_id, 64), offer_id: clean(p.offer_id, 64), kind: clean(p.kind, 20), planned_url: ownLink(p.offer_url) } },
            },
        };
    },
    'trade.alert.triggered'(event) {
        if (event.source !== 'trade') return 'ignored:source';
        const s = event.subject && typeof event.subject === 'object' ? event.subject : {};
        if (s.type !== 'user') return 'ignored:payload';
        const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
        const ins = p.instrument && typeof p.instrument === 'object' ? p.instrument : {};
        const rule = p.rule && typeof p.rule === 'object' ? p.rule : {};
        const t = p.trigger && typeof p.trigger === 'object' ? p.trigger : {};
        const symbol = clean(ins.symbol, 20);
        if (!symbol) return 'ignored:payload';
        let what;
        if (t.kind === 'observation') {
            what = `${clean(t.metric || rule.metric, 60)} is ${clean(t.value, 30)}${t.unit ? ' ' + clean(t.unit, 20) : ''}${rule.operator && rule.threshold ? ` (${clean(rule.operator, 5)} ${clean(rule.threshold, 30)})` : ''}`;
        } else if (t.kind === 'document') {
            what = `New ${clean(t.form_type, 20) || 'document'}${t.title ? ': ' + clean(t.title, 160) : ''}`;
        } else {
            return 'ignored:payload';
        }
        const disclaimer = clean(p.disclaimer, 120);
        return {
            subject: s.id,
            notification: {
                type: 'TRADE_ALERT', category: 'service', priority: 'high', icon: '📈', title: clean(`Trade alert: ${symbol}`, 60),
                message: clean(`${ins.name ? clean(ins.name, 80) + ' — ' : ''}${what}.${disclaimer ? ' ' + disclaimer : ''}`, 400),
                service: 'trade', url: publicLink(ins.url),
                rich_content: { service: 'trade', context: { event_id: event.event_id, rule_id: clean(rule.id, 64), delivery_id: clean(p.delivery_id, 64), trigger: clean(t.kind, 20), planned_url: ownLink(ins.url) } },
            },
        };
    },
};

/** The facts of a live.stream.started envelope, or an 'ignored:*' outcome. No I/O. */
function liveStarted(event, { now, maxAgeMs }) {
    if (event.source !== 'live') return 'ignored:source';
    const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (p.redacted === true) return 'ignored:redacted';
    const streamId = typeof p.stream_id === 'number' || /^\d{1,15}$/.test(String(p.stream_id)) ? Number(p.stream_id) : NaN;
    if (!Number.isSafeInteger(streamId) || streamId <= 0) return 'ignored:payload';
    const ch = p.channel && typeof p.channel === 'object' ? p.channel : {};
    const subject = ch.subject && typeof ch.subject === 'object' && ch.subject.type === 'user' ? ch.subject.id : null;
    if (!ids.isSubjectId('user', subject)) return 'ignored:channel';
    const username = clean(ch.username, 40);
    if (!username) return 'ignored:payload';
    const started = Date.parse(p.started_at || event.occurred_at || '');
    if (Number.isFinite(started) && now - started > maxAgeMs) return 'ignored:stale';
    return {
        streamId, subject, username, displayName: clean(ch.display_name, 60) || username,
        title: clean(p.title, 200) || null, protocol: clean(p.protocol, 20) || null,
        url: require('./stream-live').canonicalChannelUrl(publicLink(ch.url), username),
    };
}

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.db
 * @param {{ create(data: object): object|null }} o.notifications  NotificationService
 * @param {string|string[]} o.secrets  NETWORK_EVENTS_SECRET (comma list) or an array
 * @param {{ forStream(id: number): Promise<object> }} [o.liveFollowers]  ./live-followers.js
 * @param {() => ({ sendLiveAlert(streamer: object, stream: object): Promise<object> }|null)} [o.discord]
 */
function createEventsConsumer({ db, notifications, secrets, liveFollowers = null, discord = () => null, moderationAudit = null, liveStartedMaxAgeMs = LIVE_STARTED_MAX_AGE_MS, now = () => Date.now(), log = console }) {
    const keys = Array.isArray(secrets) ? secrets.filter((s) => typeof s === 'string' && s.length >= 32) : secretsFrom(secrets);
    const inbox = createInbox(db, { table: INBOX_TABLE, now });
    inbox.ensureSchema();
    const userBySubject = db.prepare('SELECT id FROM users WHERE subject_id = ?');
    const streamerBySubject = db.prepare('SELECT id, username, display_name, avatar_url FROM users WHERE subject_id = ?');
    const userById = db.prepare('SELECT id FROM users WHERE id = ?');

    /**
     * Work that needs I/O before the inbox transaction (it must be synchronous). Returns what the
     * handler needs, or throws LiveFollowersError when the source cannot answer (retried by Events).
     */
    const PREPARE = {
        async 'live.stream.started'(event) {
            const v = liveStarted(event, { now: now(), maxAgeMs: liveStartedMaxAgeMs });
            if (typeof v === 'string') return { skip: v };
            if (!streamerBySubject.get(v.subject)) return { skip: 'ignored:channel' };   // not a Network account: nobody to announce
            if (!liveFollowers) throw new LiveFollowersError('no Live followers client (RS256 signing key and OV_LIVE_INTERNAL_URL needed)');
            return liveFollowers.forStream(v.streamId);
        },
    };

    /** live.stream.started inside the inbox transaction: the announcement window, then one notification per person. */
    function liveStreamStarted(event, prep) {
        if (prep && prep.skip) return prep.skip;
        const v = liveStarted(event, { now: now(), maxAgeMs: liveStartedMaxAgeMs });
        if (typeof v === 'string') return v;
        if (!prep || prep.missing) return 'ignored:stream';
        if (prep.channelSubject !== v.subject) return 'ignored:channel-mismatch';   // that stream is not this channel's
        const streamer = streamerBySubject.get(v.subject);
        if (!streamer) return 'ignored:channel';
        const claim = streamLive.claimAnnouncement(db, { streamerKey: streamer.id, streamId: v.streamId, now: now() });
        if (claim.skipped) return { outcome: `skipped:${claim.reason}`, detail: { next_allowed_at: claim.next_allowed_at || null } };
        const targets = new Set();
        let unresolved = 0;
        for (const f of prep.followers || []) {
            let uid = null;
            if (f.subject && ids.isSubjectId('user', f.subject)) { const u = userBySubject.get(f.subject); if (u) uid = u.id; }
            if (uid == null && f.network_user_id) { const u = userById.get(f.network_user_id); if (u) uid = u.id; }
            if (uid == null) { unresolved++; continue; }
            targets.add(uid);
        }
        for (const uid of streamLive.allLiveSubscribers(db)) targets.add(uid);
        targets.delete(streamer.id);   // never tell streamers about themselves
        const notification = streamLive.streamLiveNotification({
            username: v.username, displayName: v.displayName, avatarUrl: streamer.avatar_url, senderId: streamer.id,
            stream: { id: v.streamId, title: v.title, protocol: v.protocol, event_id: event.event_id }, url: v.url,
        });
        const created = targets.size ? notifications.createBulk([...targets], notification) : [];
        const detail = { followers: (prep.followers || []).length, unresolved, targets: targets.size, notified: created.length, ...(prep.truncated ? { truncated: true } : {}) };
        const after = () => {
            const d = discord && discord();
            if (!d || typeof d.sendLiveAlert !== 'function') return;
            Promise.resolve()
                .then(() => d.sendLiveAlert({ username: v.username, display_name: v.displayName, avatar_url: streamer.avatar_url || null }, { id: v.streamId, title: v.title, protocol: v.protocol }))
                .catch((err) => log.warn(`[Events consumer] Discord live alert for ${v.username} failed:`, err.message));
        };
        return { outcome: created.length ? 'notified' : targets.size ? 'suppressed:preference' : 'no-recipients', detail, after };
    }

    /** Apply one envelope (with what PREPARE fetched for it). Returns { duplicate, outcome, detail }. Throws only on a storage failure. */
    function apply(event, prep) {
        let after = null;
        const r = inbox.once(CONSUMER, event.event_id, () => {
            // Staff actions go to the moderation audit log (ADR-022), never to anyone's inbox.
            if (AUDIT_TOPICS.includes(event.event_type)) return moderationAudit ? moderationAudit.record(event) : 'ignored:audit_off';
            if (event.event_type === 'live.stream.started') {
                const out = liveStreamStarted(event, prep);
                if (typeof out === 'string') return out;
                after = out.after || null;
                return { outcome: out.outcome, detail: out.detail };
            }
            const handler = Object.prototype.hasOwnProperty.call(HANDLERS, event.event_type) ? HANDLERS[event.event_type] : null;
            if (!handler) return 'ignored:type';
            const out = handler(event);
            if (typeof out === 'string') return out;
            if (!ids.isSubjectId('user', out.subject)) return 'ignored:recipient';
            const user = userBySubject.get(out.subject);
            if (!user) return 'ignored:recipient';
            // create() returns null when the person turned the category off.
            return notifications.create({ ...out.notification, user_id: user.id }) ? 'notified' : 'suppressed:preference';
        });
        if (r.duplicate) return { duplicate: true, outcome: null };
        // Side effects outside the database run only after the commit, once per event.
        if (after) { try { after(); } catch (err) { log.warn('[Events consumer] after-commit step failed:', err.message); } }
        return typeof r.result === 'object' && r.result ? { duplicate: false, outcome: r.result.outcome, detail: r.result.detail } : { duplicate: false, outcome: r.result };
    }

    const router = express.Router();
    router.post('/', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
        if (!keys.length) return http.sendProblem(res, 503, 'network.webhook_disabled', { detail: 'NETWORK_EVENTS_SECRET is not set' });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let delivery = null;
        // Signature v2 only: a v1-only (v2 stripped), stale or forged delivery is refused.
        for (const s of keys) { delivery = parseDelivery(raw, req.headers, s, { requireV2: true, now: now() }); if (delivery) break; }
        if (!delivery) return http.sendProblem(res, 401, 'network.bad_signature', { detail: 'X-OpenVibe-Signature-V2 does not verify or is outside the replay window' });
        const event = delivery.event;
        if (!event || typeof event !== 'object' || typeof event.event_id !== 'string' || !EVENT_ID_RE.test(event.event_id) || typeof event.event_type !== 'string') {
            return http.sendProblem(res, 400, 'network.bad_delivery', { detail: 'body must be { event: <envelope>, seq }' });
        }
        let prep;
        if (Object.prototype.hasOwnProperty.call(PREPARE, event.event_type)) {
            // Already handled: answer without asking anyone anything.
            if (inbox.seen(CONSUMER, event.event_id)) return res.status(200).json({ event_id: event.event_id, duplicate: true, outcome: null });
            try {
                prep = await PREPARE[event.event_type](event);
            } catch (err) {
                const known = err instanceof LiveFollowersError;
                log.warn(`[Events consumer] ${event.event_id} (${event.event_type}) not ready: ${err.message}`);
                return http.sendProblem(res, known ? 503 : 500, known ? 'network.dependency_unavailable' : 'network.event_failed', { detail: known ? 'the followers could not be read from Live; it will be retried' : 'processing failed; it will be retried' });
            }
        }
        let out;
        try {
            out = apply(event, prep);
        } catch (err) {
            // Not acknowledged: the inbox claim rolled back with the notification, and Events retries.
            log.error(`[Events consumer] ${event.event_id} (${event.event_type}) failed:`, err.message);
            return http.sendProblem(res, 500, 'network.event_failed', { detail: 'processing failed; it will be retried' });
        }
        // A go-live's outcome is logged (counts only): how an operator sees that the consumer, not Live's
        // direct call, notified a real go-live (compatibility register C-85).
        if (event.event_type === 'live.stream.started' && !out.duplicate && typeof log.log === 'function') {
            log.log(`[Events consumer] live.stream.started ${event.event_id}: ${out.outcome}${out.detail ? ` ${JSON.stringify(out.detail)}` : ''}`);
        }
        res.status(200).json({ event_id: event.event_id, duplicate: out.duplicate, outcome: out.outcome, ...(out.detail ? { detail: out.detail } : {}) });
    });

    return { router, apply, enabled: keys.length > 0 };
}

module.exports = { createEventsConsumer, CONSUMER, TOPICS, INBOX_TABLE, LIVE_STARTED_MAX_AGE_MS, secretsFrom };
