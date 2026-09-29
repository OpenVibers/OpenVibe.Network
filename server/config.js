'use strict';

require('dotenv').config();

module.exports = {
    port: parseInt(process.env.PORT, 10) || 4000,
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
    baseUrl: process.env.BASE_URL || 'https://openvibe.network',
    networkUrl: process.env.OV_NETWORK_URL || process.env.BASE_URL || 'https://openvibe.network',
    loginUrl: process.env.LOGIN_URL || process.env.OV_NETWORK_URL || process.env.BASE_URL || 'https://openvibe.network',
    internalUrl: process.env.INTERNAL_URL || process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000',
    setupToken: process.env.SETUP_TOKEN || '',
    bootstrapProfile: process.env.BOOTSTRAP_PROFILE || 'local-dev',

    jwt: {
        // RS256 keypair — generate with:
        //   openssl genrsa -out data/keys/private.pem 2048
        //   openssl rsa -in data/keys/private.pem -pubout -out data/keys/public.pem
        privateKeyPath: process.env.JWT_PRIVATE_KEY || 'data/keys/private.pem',
        publicKeyPath:  process.env.JWT_PUBLIC_KEY  || 'data/keys/public.pem',
        accessTokenExpiry:  '7d',
        refreshTokenExpiry: '30d',
        // issuer is the canonical public network URL — updated at runtime from registry
        issuer: process.env.OV_NETWORK_URL || process.env.BASE_URL || 'https://openvibe.network',
    },


    // Developer projects (server/developer, ADR-014)
    developer: {
        // Audiences that accept sandbox app tokens (comma list). Unset = the code default
        // (openvibe.media, openvibe.events, openvibe.tools: server/developer/policy.js); set to an
        // empty value = none, so sandbox apps get no tokens at all.
        sandboxAudiences: process.env.DEV_SANDBOX_AUDIENCES,
        // Public capabilities every project's SANDBOX apps may hold without staff (comma list).
        // Unset = the code default (media.object.*, events.app.*, tools.job.*); empty = none.
        // Production apps only ever use the staff-set project allowance.
        sandboxAllowance: process.env.DEV_SANDBOX_ALLOWANCE,
        // How long a rotated client secret keeps working (seconds, 0..604800).
        credentialOverlapS: process.env.DEV_CREDENTIAL_OVERLAP_S || 86400,
        // Capabilities every new project's allowance starts with (public ones only; comma list).
        defaultAllowance: process.env.DEV_DEFAULT_ALLOWANCE || '',
        maxProjectsPerOwner: process.env.DEV_MAX_PROJECTS_PER_OWNER || 10,
        maxAppsPerProject: process.env.DEV_MAX_APPS_PER_PROJECT || 20,
    },

    // OpenVibe.Events base URL for Network's own events (developer projects). Unset = no relay:
    // events stay in dev_audit and are backfilled when it is set. Production: http://127.0.0.1:4300
    eventsInternalUrl: process.env.OV_EVENTS_INTERNAL_URL || '',
    // Signing secret(s) of Network's Events subscriptions (POST /internal/events → notifications;
    // server/notifications/events-consumer.js). Comma-separated for rotation, each 32+ characters.
    // Unset = the consumer answers 503 and nothing is delivered. Handed to Events by
    // scripts/subscribe-events.js.
    eventsWebhookSecrets: process.env.NETWORK_EVENTS_SECRET || '',

    // Database (ADR-035, plan T2): PostgreSQL through PgBouncer in production. `url` (DATABASE_URL) serves
    // requests; `directUrl` (DATABASE_DIRECT_URL, the owner role on a direct connection) runs migrations.
    // Without DATABASE_URL, development and tests run an embedded PGlite database in `pgliteDir`
    // (PGLITE_DIR overrides it); production refuses to boot. `path` is the retired SQLite file: it is
    // read only by the one-time import (scripts/migrate-to-postgres.js) and reset-db, never by serving code.
    db: {
        path: process.env.DB_PATH || './data/network.db',
        url: process.env.DATABASE_URL || '',
        directUrl: process.env.DATABASE_DIRECT_URL || '',
        pgliteDir: process.env.PGLITE_DIR || 'data/pglite',
    },

    // Valkey (ADR-035, plan T2): the shared store behind the per-actor limits and any short-lived shared
    // state, so every process and host counts one actor together. Unset = this process's own counters
    // (and, for the limits, a Valkey outage degrades to them rather than answering 500). PostgreSQL stays
    // the source of truth; nothing here is a cache of record.
    valkey: {
        url: process.env.VALKEY_URL || '',
    },

    // Admin auto-creation
    admin: {
        username: process.env.ADMIN_USERNAME || '',
        password: process.env.ADMIN_PASSWORD || '',
    },

    // Upload paths
    avatars: {
        path: process.env.AVATAR_PATH || 'data/avatars',
        maxSize: 512 * 1024, // 512 KB
    },

    // Connected services (OAuth2 clients are registered in the DB,
    // but we allow env-based overrides for the internal API URLs)
    services: {
        live: {
            internalUrl: process.env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000',
            webhookSecret: process.env.OV_LIVE_WEBHOOK_SECRET || '',
        },
        tools: {
            internalUrl: process.env.OV_TOOLS_INTERNAL_URL || 'http://127.0.0.1:4001',
        },
        games: {
            internalUrl: process.env.OV_GAMES_INTERNAL_URL || 'http://127.0.0.1:8000',
            webhookSecret: process.env.OV_GAMES_WEBHOOK_SECRET || '',
        },
        media: {
            internalUrl: process.env.OV_MEDIA_INTERNAL_URL || 'http://127.0.0.1:4100',
        },
    },
};
