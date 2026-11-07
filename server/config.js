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
    // The account hub's own home (plan OpenVibe_Seven_Domains_Plan §4): openvibe.my is Network's OAuth client 'my',
    // with PKCE and a host-only session on that origin. The secret is the client's row in oauth_clients unless the
    // host sets OV_MY_OAUTH_CLIENT_SECRET (or the generic OV_OAUTH_CLIENT_* pair from setup/service-principal.js).
    my: {
        clientId: process.env.OV_MY_OAUTH_CLIENT_ID || 'my',
        clientSecret: process.env.OV_MY_OAUTH_CLIENT_SECRET
            || (process.env.OV_OAUTH_CLIENT_ID === 'my' ? process.env.OV_OAUTH_CLIENT_SECRET : '')
            || '',
        baseUrl: process.env.OV_MY_URL || 'https://openvibe.my',
    },
    setupToken: process.env.SETUP_TOKEN || '',
    bootstrapProfile: process.env.BOOTSTRAP_PROFILE || 'local-dev',

    jwt: {
        // RS256 keypair — generate with:
        //   openssl genrsa -out data/keys/private.pem 2048
        //   openssl rsa -in data/keys/private.pem -pubout -out data/keys/public.pem
        privateKeyPath: process.env.JWT_PRIVATE_KEY || 'data/keys/private.pem',
        publicKeyPath:  process.env.JWT_PUBLIC_KEY  || 'data/keys/public.pem',
        // The EC (P-256) key that signs the subject assertions (ADR-003, the 2026-11-06 amendment;
        // plan H1). It is published in the JWKS next to the RS256 key, so Billing and Tips can verify
        // an assertion offline. It is generated and kept on first boot when the files are not there.
        assertionPrivateKeyPath: process.env.JWT_ASSERTION_PRIVATE_KEY || 'data/keys/assertion-private.pem',
        assertionPublicKeyPath:  process.env.JWT_ASSERTION_PUBLIC_KEY  || 'data/keys/assertion-public.pem',
        accessTokenExpiry:  '7d',
        refreshTokenExpiry: '30d',
        // issuer is the canonical public network URL — updated at runtime from registry
        issuer: process.env.OV_NETWORK_URL || process.env.BASE_URL || 'https://openvibe.network',
    },


    // Subject assertions (ADR-003, the 2026-11-06 amendment; plan H1): the audiences Network signs an
    // assertion for. The money services by default; a deployment may narrow or widen the list.
    subjectAssertions: {
        audiences: String(process.env.NETWORK_SUBJECT_ASSERTION_AUDIENCES || 'openvibe.billing,openvibe.tips')
            .split(',').map((s) => s.trim()).filter(Boolean),
    },

    // Sign in on another device (owner, 2026-11-04; server/auth/qr-signin.js): a QR on the source device, a
    // scan on the target and a two-digit match. Off unless NETWORK_QR_SIGNIN is explicitly on; off means the routes and /q are not mounted.
    qrSignin: {
        enabled: /^(1|true|on|yes)$/i.test(String(process.env.NETWORK_QR_SIGNIN || '')),
    },

    // Project secrets (ADR-056, server/developer/secrets.js): 32 random bytes, base64 or hex. Unset = the feature is off
    // (503 secrets.unavailable); values are only ever stored encrypted under keys derived from it.
    secrets: {
        key: process.env.NETWORK_SECRETS_KEY || '',
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
        // First-party services (OAuth client ids) that may host a project member's agents (comma list).
        // Unset = the code default (actor: server/developer/policy.js); set to an empty value = none.
        agentHostServices: process.env.AGENT_HOST_SERVICES,
        // Developer API keys and per-project budgets (plan G-P3, server/developer/api-keys.js).
        // Off unless NETWORK_DEV_API_KEYS=1: the key lifecycle, the key exchange and the budget routes
        // answer 503 api_keys.disabled while it is off.
        apiKeys: process.env.NETWORK_DEV_API_KEYS === '1',
    },

    // OpenVibe.Events base URL for Network's own events (developer projects). Unset = no relay:
    // events stay in dev_audit and are backfilled when it is set. Production: http://127.0.0.1:4300
    eventsInternalUrl: process.env.OV_EVENTS_INTERNAL_URL || '',
    // Signing secret(s) of Network's Events subscriptions (POST /internal/events → notifications;
    // server/notifications/events-consumer.js). Comma-separated for rotation, each 32+ characters.
    // Unset = the consumer answers 503 and nothing is delivered. Handed to Events by
    // scripts/subscribe-events.js.
    eventsWebhookSecrets: process.env.NETWORK_EVENTS_SECRET || '',

    // IndexNow (openvibe-shared/indexnow): when INDEXNOW_KEY is set the key file is served at /<key>.txt.
    // Network publishes no content stream, so nothing pings yet. Unset: off — nothing is mounted.
    indexnow: { key: process.env.INDEXNOW_KEY || '' },

    // Database (ADR-035, plan T2): PostgreSQL through PgBouncer in production. `url` (DATABASE_URL) serves
    // requests; `directUrl` (DATABASE_DIRECT_URL, the owner role on a direct connection) runs migrations.
    // Without DATABASE_URL, development and tests run an embedded PGlite database in `pgliteDir`
    // (PGLITE_DIR overrides it); production refuses to boot.
    db: {
        url: process.env.DATABASE_URL || '',
        directUrl: process.env.DATABASE_DIRECT_URL || '',
        pgliteDir: process.env.PGLITE_DIR || 'data/pglite',
    },

    // Local data directory (account exports, and the avatar path's default parent). DATA_DIR overrides it.
    dataDir: process.env.DATA_DIR || 'data',

    // Valkey (ADR-035, plan T2): the shared store behind the per-actor limits and any short-lived shared
    // state, so every process and host counts one actor together. Unset = this process's own counters
    // (and, for the limits, a Valkey outage degrades to them rather than answering 500). PostgreSQL stays
    // the source of truth; nothing here is a cache of record.
    valkey: {
        url: process.env.VALKEY_URL || '',
        prefix: process.env.VALKEY_PREFIX || 'ov:network:',
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
        // OpenVibe.Chat: the admin panel's TTS settings (server/admin/service-proxies.js).
        chat: {
            internalUrl: process.env.OV_CHAT_INTERNAL_URL || 'http://127.0.0.1:4400',
        },
        // OpenVibe.Search: the navbar's suggestions (GET /api/frame/suggest, server/frame/service.js).
        search: {
            internalUrl: process.env.OV_SEARCH_INTERNAL_URL || 'http://127.0.0.1:4710',
        },
        // OpenVibe.Billing: the person's Vibes beside their OpenCoins (GET /api/coins/me?with=vibes, server/coins/routes.js).
        billing: {
            internalUrl: process.env.OV_BILLING_INTERNAL_URL || 'http://127.0.0.1:4600',
        },
        // OpenVibe.Bot: the registry of the machines. The hub (server/registry/machines.js) calls it as the
        // person, so Bot stays the authority on what a person may do with their own machines.
        bot: {
            internalUrl: process.env.OV_BOT_INTERNAL_URL || 'http://127.0.0.1:4630',
        },
        // The owner's settings proxy (server/admin/ai-config-proxy.js, D11 S3): each service's /internal/config,
        // reached with Network's own token for openvibe.<service> and the owner in X-OV-Subject. Four are already
        // above (billing); these are the rest. The URLs are operator config: never a request value.
        ai: {
            internalUrl: process.env.OV_AI_INTERNAL_URL || 'http://127.0.0.1:4700',
        },
        services: {
            internalUrl: process.env.OV_SERVICES_INTERNAL_URL || 'http://127.0.0.1:4930',
        },
        watch: {
            internalUrl: process.env.OV_WATCH_INTERNAL_URL || 'http://127.0.0.1:4730',
        },
        bench: {
            internalUrl: process.env.OV_BENCH_INTERNAL_URL || 'http://127.0.0.1:5230',
        },
        report: {
            internalUrl: process.env.OV_REPORT_INTERNAL_URL || 'http://127.0.0.1:5080',
        },
        host: {
            internalUrl: process.env.OV_HOST_INTERNAL_URL || 'http://127.0.0.1:4910',
        },
        codes: {
            internalUrl: process.env.OV_CODES_INTERNAL_URL || 'http://127.0.0.1:4900',
        },
        actor: {
            internalUrl: process.env.OV_ACTOR_INTERNAL_URL || 'http://127.0.0.1:4950',
        },
        // The owner's Setup tab (server/admin/setup.js) reaches every service that holds an owner input. Chat and
        // Media are above; these are the rest.
        connect: {
            internalUrl: process.env.OV_CONNECT_INTERNAL_URL || 'http://127.0.0.1:5240',
        },
        deals: {
            internalUrl: process.env.OV_DEALS_INTERNAL_URL || 'http://127.0.0.1:4840',
        },
        work: {
            internalUrl: process.env.OV_WORK_INTERNAL_URL || 'http://127.0.0.1:4960',
        },
        sources: {
            internalUrl: process.env.OV_SOURCES_INTERNAL_URL || 'http://127.0.0.1:4720',
        },
        design: {
            internalUrl: process.env.OV_DESIGN_INTERNAL_URL || 'http://127.0.0.1:5090',
        },
        domains: {
            internalUrl: process.env.OV_DOMAINS_INTERNAL_URL || 'http://127.0.0.1:5070',
        },
    },
};
