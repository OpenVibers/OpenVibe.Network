'use strict';
/**
 * OpenVibe.Events → notifications: POST /internal/events, the endpoint of Network's Events
 * subscriptions (consumer `network`, created by scripts/subscribe-events.js).
 *
 *   deals.watch.matched     a Deals watch (keyword, product, price below) matched a fresh observation;
 *                           payload.recipient is the watcher's usr_ subject
 *   trade.alert.triggered   a Trade alert rule fired (threshold crossed, filing/document seen);
 *                           event.subject { type: 'user', id } is the rule's owner
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
 * public domain serves the service (server/chrome/sites.js, via the exposure overlay). Today Deals
 * and Trade are loopback-only and their domains show placeholder pages, so the link is kept in
 * rich_content.context.planned_url and the notification has no click-through yet.
 */
const express = require('express');
const { http, ids } = require('openvibe-contracts');
const { parseDelivery, createInbox } = require('openvibe-sdk/events');
const { siteForHost } = require('../chrome/sites');

const CONSUMER = 'network-notifications';
const INBOX_TABLE = 'network_event_inbox';
const TOPICS = Object.freeze(['deals.watch.matched', 'trade.alert.triggered']);
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

/**
 * @param {object} o
 * @param {import('better-sqlite3').Database} o.db
 * @param {{ create(data: object): object|null }} o.notifications  NotificationService
 * @param {string|string[]} o.secrets  NETWORK_EVENTS_SECRET (comma list) or an array
 */
function createEventsConsumer({ db, notifications, secrets, now = () => Date.now(), log = console }) {
    const keys = Array.isArray(secrets) ? secrets.filter((s) => typeof s === 'string' && s.length >= 32) : secretsFrom(secrets);
    const inbox = createInbox(db, { table: INBOX_TABLE, now });
    inbox.ensureSchema();
    const userBySubject = db.prepare('SELECT id FROM users WHERE subject_id = ?');

    /** Apply one envelope. Returns { duplicate, outcome }. Throws only on a storage failure. */
    function apply(event) {
        const r = inbox.once(CONSUMER, event.event_id, () => {
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
        return r.duplicate ? { duplicate: true, outcome: null } : { duplicate: false, outcome: r.result };
    }

    const router = express.Router();
    router.post('/', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
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
        let out;
        try {
            out = apply(event);
        } catch (err) {
            // Not acknowledged: the inbox claim rolled back with the notification, and Events retries.
            log.error(`[Events consumer] ${event.event_id} (${event.event_type}) failed:`, err.message);
            return http.sendProblem(res, 500, 'network.event_failed', { detail: 'processing failed; it will be retried' });
        }
        res.status(200).json({ event_id: event.event_id, duplicate: out.duplicate, outcome: out.outcome });
    });

    return { router, apply, enabled: keys.length > 0 };
}

module.exports = { createEventsConsumer, CONSUMER, TOPICS, INBOX_TABLE, secretsFrom };
