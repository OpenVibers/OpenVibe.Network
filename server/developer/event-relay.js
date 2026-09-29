'use strict';
/**
 * Relay of Network's developer-project events to OpenVibe.Events (ADR-004 outbox semantics).
 *
 * store.audit() writes each network.app.* / network.credential.* / network.grant.changed envelope
 * into its dev_audit row. When the relay is on (OV_EVENTS_INTERNAL_URL is set), the same
 * transaction also enqueues the envelope into `network_event_outbox` (openvibe-sdk createOutbox),
 * and the relay publishes due rows in id order. On start it backfills every dev_audit event that is
 * not in the outbox yet (INSERT OR IGNORE by event_id, in dev_audit id order), so events written
 * while the relay was off are delivered too. Delivery is at least once; Events answers a repeated
 * event_id as a duplicate. Sent rows are kept (never pruned), so a backfill can never republish an
 * event after Events has forgotten its id.
 *
 * Authentication: Network is the token issuer, so it signs its own 5-minute service token
 * (sub svc:network, aud openvibe.events, cap events.event.publish; identity.service-token-claims@1)
 * with its private key instead of asking itself for one.
 */
const crypto = require('crypto');
const { serviceAuth, assertValid } = require('openvibe-contracts');
const { createClient } = require('openvibe-sdk/core');
const { createEventsClient, createPgOutbox } = require('openvibe-sdk/events');

const TABLE = 'network_event_outbox';
const TOKEN_TTL_S = 300;
const outboxes = new WeakMap();   // db -> outbox, only while the relay is configured
const passives = new WeakMap();   // db -> outbox that only writes rows (never started)
const writers = new WeakMap();    // db -> the enqueue facade writerFor() returns (one per database)

/** The outbox registered for this database, or null (relay off). store.audit() enqueues into it. */
function outboxFor(db) {
    return outboxes.get(db) || null;
}

/**
 * An outbox to enqueue into whether or not this process relays: the running relay's, else a passive
 * one on the same table that is never started. Rows written while the relay is off (OV_EVENTS_INTERNAL_URL
 * unset, or a script beside the server) wait in network_event_outbox; whichever process relays sends them,
 * the server within its next poll. Used by events that have no other durable record to backfill from
 * (user modules: server/identity/module-events.js); dev_audit events keep their backfill.
 */
function writerFor(db) {
    const cached = writers.get(db);
    if (cached) return cached;
    const live = outboxes.get(db);
    let outbox = live;
    if (!outbox) {
        outbox = passives.get(db);
        if (!outbox) {
            const events = createEventsClient(createClient({ network: 'https://openvibe.network', baseUrls: { events: 'http://127.0.0.1:1' } }), { source: 'network' });
            outbox = createPgOutbox(db, { events, table: TABLE });
            passives.set(db, outbox);
        }
    }
    // The PostgreSQL outbox enqueues on the transaction handle (enqueue(t, envelope, opts)); caller sites
    // also pass the envelope first. Accept both shapes, always binding this database as the handle so the
    // row joins the caller's ambient db.tx. One facade per database, so a caller (a test) can swap enqueue.
    const writer = {
        enqueue: (a, b, c) => (a && typeof a.query === 'function' && typeof a.tx === 'function')
            ? outbox.enqueue(a, b, c)
            : outbox.enqueue(db, a, b),
    };
    writers.set(db, writer);
    return writer;
}

/** A self-signed Network service token for publishing to Events, cached until a minute before exp. */
function createSelfTokenSource({ privateKey, issuer }) {
    let cached = null;
    return {
        getToken() {
            const now = Math.floor(Date.now() / 1000);
            if (cached && cached.exp - 60 > now) return cached.token;
            const claims = {
                iss: issuer, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.events'], cap: ['events.event.publish'],
                iat: now, exp: now + TOKEN_TTL_S, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
            };
            assertValid('identity.service-token-claims@1', claims);
            cached = { token: serviceAuth.signServiceToken(claims, privateKey), exp: claims.exp };
            return cached.token;
        },
        invalidate() { cached = null; },
    };
}

/** Copy dev_audit events that are not in the outbox yet, oldest first. Returns how many were added. */
async function backfill(db) {
    const rows = await db.prepare(`SELECT id, event FROM dev_audit WHERE event IS NOT NULL
        AND (event::jsonb ->> 'event_id') NOT IN (SELECT event_id FROM ${TABLE}) ORDER BY id`).all();
    const insert = db.prepare(`INSERT INTO ${TABLE} (event_id, envelope, traceparent, created_at, next_attempt_at) VALUES (?, ?, NULL, ?, 0) ON CONFLICT DO NOTHING`);
    let added = 0;
    await db.tx(async () => {
        for (const r of rows) {
            const env = JSON.parse(r.event);
            added += (await insert.run(env.event_id, r.event, Date.now())).changes;
        }
    });
    return added;
}

/**
 * Start the relay for `db` when `eventsUrl` is set; returns the outbox (or null when off).
 * fetch/intervalMs are injectable for tests.
 */
async function startRelay(db, { eventsUrl, privateKey, issuer, fetch: fetchImpl, intervalMs = 2000, log = console, autoStart = true } = {}) {
    if (!eventsUrl) return null;
    if (!privateKey || !String(privateKey).includes('BEGIN')) {
        log.warn('[events-relay] OV_EVENTS_INTERNAL_URL is set but Network has no RS256 private key; relay stays off');
        return null;
    }
    const tokens = createSelfTokenSource({ privateKey, issuer });
    const client = createClient({
        network: issuer,
        baseUrls: { events: String(eventsUrl).replace(/\/+$/, '') },
        tokenProvider: tokens,
        retries: 1,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    const events = createEventsClient(client, { source: 'network' });
    const outbox = createPgOutbox(db, {
        events, table: TABLE, intervalMs,
        onError: (err) => log.warn(`[events-relay] publish failed: ${String((err && err.message) || err).slice(0, 200)}`),
    });
    outboxes.set(db, outbox);
    const added = await backfill(db);
    if (added) log.log(`[events-relay] backfilled ${added} developer-project event(s) from dev_audit`);
    if (autoStart) outbox.start();
    return outbox;
}

function stopRelay(db) {
    const outbox = outboxes.get(db);
    outboxes.delete(db);
    return outbox ? outbox.stop() : Promise.resolve();
}

module.exports = { startRelay, stopRelay, outboxFor, writerFor, backfill, createSelfTokenSource, TABLE };
