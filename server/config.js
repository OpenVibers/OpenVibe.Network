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
        accessTokenExpiry:  '24h',
        refreshTokenExpiry: '30d',
        // issuer is the canonical public network URL — updated at runtime from registry
        issuer: process.env.OV_NETWORK_URL || process.env.BASE_URL || 'https://openvibe.network',
    },

    // Internal API key for server-to-server calls (X-Internal-Key)
    internalKey: process.env.INTERNAL_API_KEY || 'change-me-in-production',

    // Database
    db: {
        path: process.env.DB_PATH || './data/network.db',
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
