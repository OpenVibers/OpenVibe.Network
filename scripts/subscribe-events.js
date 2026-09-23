#!/usr/bin/env node
'use strict';
/**
 * Create Network's OpenVibe.Events subscriptions for the notification consumer
 * (server/notifications/events-consumer.js): one per topic in TOPICS (deals.watch.matched,
 * trade.alert.triggered), all delivering to POST /internal/events. Events names the consumer after
 * the calling service: `network`.
 *
 *   sudo node --env-file=/etc/openvibe/network.env scripts/subscribe-events.js \
 *        [--endpoint http://127.0.0.1:4000/internal/events] [--dry-run]
 *
 * Reads the environment: OV_EVENTS_INTERNAL_URL (Events, e.g. http://127.0.0.1:4300), OV_NETWORK_URL
 * (the token issuer), JWT_PRIVATE_KEY (default data/keys/private.pem) and NETWORK_EVENTS_SECRET — the
 * delivery signing secret; its FIRST value is handed to Events, so generate it and restart Network
 * with it first (`openssl rand -hex 32`). Network is the token issuer, so it signs its own 5-minute
 * service token (sub svc:network, aud openvibe.events, cap events.subscription.manage) instead of
 * asking itself for one. Nothing secret is printed. An existing identical subscription is reported,
 * not duplicated.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { serviceAuth, assertValid } = require('openvibe-contracts');
const config = require('../server/config');
const { TOPICS, secretsFrom } = require('../server/notifications/events-consumer');

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };

function selfToken(privateKey, issuer) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
        iss: issuer, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.events'], cap: ['events.subscription.manage'],
        iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
    };
    assertValid('identity.service-token-claims@1', claims);
    return serviceAuth.signServiceToken(claims, privateKey);
}

(async () => {
    const eventsUrl = String(config.eventsInternalUrl || '').replace(/\/+$/, '');
    const endpoint = opt('endpoint', `http://127.0.0.1:${config.port}/internal/events`);
    const secret = secretsFrom(config.eventsWebhookSecrets)[0];
    if (!eventsUrl) throw new Error('OV_EVENTS_INTERNAL_URL is not set');
    if (!secret) throw new Error('NETWORK_EVENTS_SECRET must be set (32+ characters) before subscribing');
    const privateKey = fs.readFileSync(path.resolve(config.jwt.privateKeyPath), 'utf8');
    if (!privateKey.includes('BEGIN')) throw new Error(`${config.jwt.privateKeyPath} is not a PEM private key`);
    if (args.includes('--dry-run')) {
        for (const t of TOPICS) console.log(`would subscribe: ${t} → ${endpoint} (consumer network, Events ${eventsUrl})`);
        return;
    }
    const token = selfToken(privateKey, config.jwt.issuer);
    for (const pattern of TOPICS) {
        const res = await fetch(`${eventsUrl}/api/v1/subscriptions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ topic_pattern: pattern, endpoint, secret }),
            signal: AbortSignal.timeout(15000),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 409 && body.subscription_id) { console.log(`subscription exists: ${body.subscription_id} (${pattern} → ${endpoint})`); continue; }
        if (!res.ok) throw new Error(`Events answered ${res.status} for ${pattern}: ${body.code || ''} ${body.detail || ''}`.trim());
        console.log(`subscribed: ${body.id} (${pattern} → ${endpoint})`);
    }
    console.log('Replay history if wanted with POST /api/v1/deliveries/replay { subscription_id, from_seq } (events.delivery.admin).');
})().catch((err) => { console.error(`subscribe failed: ${err.message}`); process.exit(1); });
