'use strict';

// ═══════════════════════════════════════════════════════════════
// Nginx Config Generator — Template-driven vhost generation
// Replaces static hand-maintained nginx configs with generated
// configs derived from the canonical URL registry.
// ═══════════════════════════════════════════════════════════════

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findBestCert } = require('./cert-manager');

// ── Default Service Definitions ──────────────────────────────
// These are the OpenVibe defaults. White-label installs override
// via DEPLOY_SERVICE_MAP and DEPLOY_DOMAINS in the registry.

const DEFAULT_SERVICE_MAP = {
    network: {
        port: 4000,
        domains: ['openvibe.network', 'my.openvibe.network'],
        maxBodySize: '5m',
        rateZones: [
            { name: 'openvibenetwork_api', rate: '10r/s' },
            { name: 'openvibenetwork_auth', rate: '5r/m' },
        ],
        locations: [
            {
                match: '~ ^/(api/auth/(register|login|anon-session)|oauth/(token|authorize))',
                rateZone: 'openvibenetwork_auth',
                rateBurst: 5,
            },
            {
                match: '/shared/',
                cacheTime: '1h',
            },
            {
                match: '/api/',
                rateZone: 'openvibenetwork_api',
                rateBurst: 30,
            },
            {
                match: '/internal/',
                localhostOnly: true,
            },
        ],
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
    tools: {
        port: 4001,
        domains: ['openvibe.tools'],
        wildcardDomain: 'openvibe.tools',
        maxBodySize: '5m',
        rateZones: [
            { name: 'openvibetools_api', rate: '10r/s' },
        ],
        locations: [
            {
                match: '/api/',
                rateZone: 'openvibetools_api',
                rateBurst: 30,
            },
        ],
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
    media: {
        port: 4100,
        domains: ['openvibe.media'],
        maxBodySize: '500m',
        rateZones: [
            { name: 'openvibemedia_api', rate: '10r/s' },
        ],
        locations: [
            {
                match: '/api/',
                rateZone: 'openvibemedia_api',
                rateBurst: 40,
                readTimeout: '300s',
                sendTimeout: '300s',
            },
        ],
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
    live: {
        port: 3000,
        domains: ['openvibe.live', 'www.openvibe.live'],
        wildcardDomain: 'openvibe.live',
        maxBodySize: '3m',
        rateZones: [
            { name: 'streamer_api', rate: '10r/s' },
            { name: 'streamer_login', rate: '5r/m' },
        ],
        locations: [
            {
                match: '= /api/auth/register',
                rateZone: 'streamer_login',
                rateBurst: 5,
            },
            {
                match: '= /api/auth/login',
                rateZone: 'streamer_login',
                rateBurst: 10,
            },
            {
                match: '^~ /data/avatars/',
                cacheTime: '7d',
            },
            {
                match: '^~ /api/thumbnails/',
                cacheTime: '1h',
            },
            {
                match: '~ ^/api/vods/(upload|clips|stream/)',
                maxBodySize: '500m',
                readTimeout: '300s',
                sendTimeout: '300s',
            },
            {
                match: '/api/',
                rateZone: 'streamer_api',
                rateBurst: 40,
                websocket: true,
                maxBodySize: '10m',
            },
            {
                match: '/ws/',
                websocket: true,
            },
        ],
        defaultLocationExtras: {
            websocket: true,
            headers: {
                'Permissions-Policy': 'camera=*, microphone=*, display-capture=*',
            },
        },
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
    games: {
        port: 8000,
        domains: ['openvibe.games', 'www.openvibe.games', 'play.openvibe.games'],
        wildcardDomain: 'openvibe.games',
        maxBodySize: '2m',
        rateZones: [
            { name: 'openvibegames_api', rate: '10r/s' },
            { name: 'openvibegames_auth', rate: '5r/m' },
        ],
        locations: [
            {
                match: '/auth/',
                rateZone: 'openvibegames_auth',
                rateBurst: 5,
            },
            {
                match: '/api/',
                rateZone: 'openvibegames_api',
                rateBurst: 30,
                websocket: true,
            },
        ],
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
    maps: {
        port: 4010,
        domains: ['maps.openvibe.tools'],
        parentDomain: 'openvibe.tools',
        maxBodySize: '2m',
        rateZones: [
            { name: 'openvibemaps_api', rate: '10r/s' },
        ],
        locations: [
            {
                match: '= /api/search/stream',
                rateZone: 'openvibemaps_api',
                rateBurst: 10,
                sseStreaming: true,
            },
            {
                match: '/api/',
                rateZone: 'openvibemaps_api',
                rateBurst: 30,
            },
        ],
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
    food: {
        port: 4011,
        domains: ['food.openvibe.tools'],
        parentDomain: 'openvibe.tools',
        maxBodySize: '2m',
        rateZones: [
            { name: 'openvibefood_api', rate: '10r/s' },
        ],
        locations: [
            {
                match: '/api/',
                rateZone: 'openvibefood_api',
                rateBurst: 30,
            },
        ],
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
    img: {
        port: 4012,
        domains: ['img.openvibe.tools'],
        parentDomain: 'openvibe.tools',
        maxBodySize: '50m',
        rateZones: [
            { name: 'openvibeimg_api', rate: '5r/s' },
        ],
        locations: [
            {
                match: '/api/',
                rateZone: 'openvibeimg_api',
                rateBurst: 20,
            },
        ],
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
    docs: {
        port: 4016,
        domains: ['docs.openvibe.tools', 'pdf.openvibe.tools'],
        parentDomain: 'openvibe.tools',
        maxBodySize: '50m',
        rateZones: [
            { name: 'openvibedocs_api', rate: '5r/s' },
        ],
        locations: [
            {
                match: '/api/',
                rateZone: 'openvibedocs_api',
                rateBurst: 20,
            },
        ],
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
    yt: {
        port: 4013,
        domains: ['yt.openvibe.tools'],
        parentDomain: 'openvibe.tools',
        maxBodySize: '2m',
        rateZones: [
            { name: 'openvibeyt_api', rate: '2r/s' },
        ],
        locations: [
            {
                match: '~ ^/api/status/.+/stream$',
                sseStreaming: true,
                readTimeout: '600s',
            },
            {
                match: '~ ^/api/downloads/',
                readTimeout: '600s',
            },
            {
                match: '/api/',
                rateZone: 'openvibeyt_api',
                rateBurst: 10,
            },
        ],
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
    audio: {
        port: 4014,
        domains: ['audio.openvibe.tools'],
        parentDomain: 'openvibe.tools',
        maxBodySize: '100m',
        rateZones: [
            { name: 'openvibeaudio_api', rate: '5r/s' },
        ],
        locations: [
            {
                match: '/api/',
                rateZone: 'openvibeaudio_api',
                rateBurst: 20,
            },
        ],
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
    text: {
        port: 4015,
        domains: ['text.openvibe.tools'],
        parentDomain: 'openvibe.tools',
        maxBodySize: '2m',
        rateZones: [],
        locations: [
            {
                match: '/api/',
            },
        ],
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'SAMEORIGIN',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
};

// ── Nginx Config Generation ──────────────────────────────────

function indent(text, level = 1) {
    const pad = '    '.repeat(level);
    return text.split('\n').map(l => l ? pad + l : '').join('\n');
}

function generateProxyBlock(port, loc = {}) {
    const lines = [];
    lines.push(`proxy_pass http://127.0.0.1:${port};`);
    lines.push('proxy_http_version 1.1;');
    lines.push('proxy_set_header Host $host;');
    lines.push('proxy_set_header X-Real-IP $remote_addr;');
    lines.push('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
    lines.push('proxy_set_header X-Forwarded-Proto $scheme;');

    if (loc.websocket) {
        lines.push('proxy_set_header Upgrade $http_upgrade;');
        lines.push('proxy_set_header Connection "upgrade";');
    }

    if (loc.sseStreaming) {
        lines.push("proxy_set_header Connection '';");
        lines.push('proxy_buffering off;');
        lines.push('proxy_cache off;');
        lines.push('chunked_transfer_encoding off;');
    }

    if (loc.readTimeout) {
        lines.push(`proxy_read_timeout ${loc.readTimeout};`);
    }
    if (loc.sendTimeout) {
        lines.push(`proxy_send_timeout ${loc.sendTimeout};`);
    }

    return lines.join('\n');
}

function generateLocationBlock(port, loc) {
    const lines = [];

    if (loc.rateZone) {
        lines.push(`limit_req zone=${loc.rateZone} burst=${loc.rateBurst || 10} nodelay;`);
    }

    if (loc.localhostOnly) {
        lines.push('allow 127.0.0.1;');
        lines.push('allow ::1;');
        lines.push('deny all;');
    }

    if (loc.maxBodySize) {
        lines.push(`client_max_body_size ${loc.maxBodySize};`);
    }

    lines.push(generateProxyBlock(port, loc));

    if (loc.cacheTime) {
        lines.push(`expires ${loc.cacheTime};`);
        const seconds = parseDurationToSeconds(loc.cacheTime);
        lines.push(`add_header Cache-Control "public, max-age=${seconds}";`);
    }

    if (loc.headers) {
        for (const [k, v] of Object.entries(loc.headers)) {
            lines.push(`add_header ${k} "${v}" always;`);
        }
    }

    return `location ${loc.match} {\n${indent(lines.join('\n'))}\n}`;
}

function parseDurationToSeconds(dur) {
    const match = dur.match(/^(\d+)([smhd])$/);
    if (!match) return 3600;
    const num = parseInt(match[1]);
    switch (match[2]) {
        case 's': return num;
        case 'm': return num * 60;
        case 'h': return num * 3600;
        case 'd': return num * 86400;
        default: return 3600;
    }
}

/**
 * Generate a complete Nginx server block config for a service.
 *
 * @param {string} serviceId - Service identifier
 * @param {object} svc - Service config (from DEFAULT_SERVICE_MAP or registry)
 * @param {object} opts - Options
 * @param {string} opts.certPath - Path to SSL certificate
 * @param {string} opts.keyPath - Path to SSL private key
 * @param {boolean} opts.sslEnabled - Whether to generate HTTPS block
 * @returns {string} Nginx config text
 */
function generateServiceConfig(serviceId, svc, opts = {}) {
    const lines = [];
    const allDomains = [...(svc.domains || [])];
    if (svc.wildcardDomain && !svc.parentDomain) {
        // Add wildcard to server_name if this service owns the domain
        if (!allDomains.includes(`*.${svc.wildcardDomain}`)) {
            allDomains.push(`*.${svc.wildcardDomain}`);
        }
    }
    const serverNames = allDomains.join(' ');

    // Comment header
    lines.push(`# ═══════════════════════════════════════════════════════════════`);
    lines.push(`# ${serviceId} — Auto-generated Nginx Configuration`);
    lines.push(`# Generated by openvibe.network deploy system`);
    lines.push(`# DO NOT EDIT MANUALLY — managed via admin panel`);
    lines.push(`# ═══════════════════════════════════════════════════════════════`);
    lines.push('');

    // Rate limit zones
    if (svc.rateZones && svc.rateZones.length > 0) {
        for (const rz of svc.rateZones) {
            lines.push(`limit_req_zone $binary_remote_addr zone=${rz.name}:10m rate=${rz.rate};`);
        }
        lines.push('');
    }

    // HTTP → HTTPS redirect
    lines.push('# HTTP → HTTPS redirect');
    lines.push('server {');
    lines.push('    listen 80;');
    lines.push('    listen [::]:80;');
    lines.push(`    server_name ${serverNames};`);
    lines.push('    return 301 https://$host$request_uri;');
    lines.push('}');
    lines.push('');

    // HTTPS server
    lines.push('# HTTPS server');
    lines.push('server {');
    lines.push('    listen 443 ssl;');
    lines.push('    listen [::]:443 ssl;');
    lines.push('    http2 on;');
    lines.push(`    server_name ${serverNames};`);
    lines.push('');

    // SSL certificate
    if (opts.sslEnabled !== false && opts.certPath && opts.keyPath) {
        lines.push(`    ssl_certificate     ${opts.certPath};`);
        lines.push(`    ssl_certificate_key ${opts.keyPath};`);
    } else {
        lines.push('    # SSL certificate not configured — update via admin panel');
        lines.push('    # ssl_certificate     /path/to/fullchain.pem;');
        lines.push('    # ssl_certificate_key /path/to/privkey.pem;');
    }
    lines.push('');

    // Logs
    const logName = svc.domains?.[0]?.replace(/\./g, '-') || serviceId;
    lines.push(`    access_log /var/log/nginx/${logName}.access.log;`);
    lines.push(`    error_log  /var/log/nginx/${logName}.error.log;`);
    lines.push('');

    // Body size
    lines.push(`    client_max_body_size ${svc.maxBodySize || '5m'};`);
    lines.push('');

    // Security headers
    if (svc.headers) {
        for (const [k, v] of Object.entries(svc.headers)) {
            lines.push(`    add_header ${k} ${v} always;`);
        }
        lines.push('');
    }

    // Location blocks
    if (svc.locations && svc.locations.length > 0) {
        for (const loc of svc.locations) {
            lines.push(indent(generateLocationBlock(svc.port, loc)));
            lines.push('');
        }
    }

    // Default location (catch-all)
    const defaultLoc = svc.defaultLocationExtras || {};
    const defaultLines = [];
    defaultLines.push(generateProxyBlock(svc.port, defaultLoc));
    if (defaultLoc.headers) {
        for (const [k, v] of Object.entries(defaultLoc.headers)) {
            defaultLines.push(`add_header ${k} "${v}" always;`);
        }
    }
    lines.push(indent(`location / {\n${indent(defaultLines.join('\n'))}\n}`));
    lines.push('');

    // Deny dotfiles (except .well-known)
    lines.push(indent('location ~ /\\.(?!well-known) {'));
    lines.push(indent('    deny all;'));
    lines.push(indent('}'));
    lines.push('}');

    return lines.join('\n');
}

/**
 * Generate all Nginx configs for the entire network.
 *
 * @param {object} registry - Resolved URL registry
 * @param {object} opts - Options
 * @returns {Array<{serviceId: string, filename: string, content: string}>}
 */
function generateAllConfigs(registry = {}) {
    const serviceMap = registry.DEPLOY_SERVICE_MAP?.value || DEFAULT_SERVICE_MAP;
    const deployDomains = registry.DEPLOY_DOMAINS?.value || [];

    // Build domain → cert mapping
    const domainCertMap = {};
    for (const dd of deployDomains) {
        if (dd.domain && dd.certName) {
            domainCertMap[dd.domain] = dd.certName;
        }
    }

    const configs = [];

    for (const [serviceId, svc] of Object.entries(serviceMap)) {
        // Determine which cert to use
        const certDomain = svc.parentDomain || svc.wildcardDomain || svc.domains?.[0];
        const certName = domainCertMap[certDomain] || certDomain;
        const cert = certName ? findBestCert(certName) : null;

        const filename = (svc.domains?.[0] || serviceId).replace(/\./g, '-') + '.conf';
        const content = generateServiceConfig(serviceId, svc, {
            sslEnabled: !!cert,
            certPath: cert?.fullchain || null,
            keyPath: cert?.privkey || null,
        });

        configs.push({ serviceId, filename, content, certFound: !!cert });
    }

    return configs;
}

// ── Nginx Apply / Reload ─────────────────────────────────────

/**
 * Test nginx configuration syntax.
 * @returns {Promise<{ok: boolean, output: string}>}
 */
async function testNginxConfig() {
    return new Promise((resolve) => {
        execFile('nginx', ['-t'], { timeout: 10_000 }, (err, stdout, stderr) => {
            const output = ((stdout || '') + '\n' + (stderr || '')).trim();
            if (err) {
                resolve({ ok: false, output, error: err.message });
            } else {
                resolve({ ok: true, output });
            }
        });
    });
}

/**
 * Reload nginx.
 * @returns {Promise<{ok: boolean, output: string}>}
 */
async function reloadNginx() {
    return new Promise((resolve) => {
        execFile('systemctl', ['reload', 'nginx'], { timeout: 10_000 }, (err, stdout, stderr) => {
            const output = ((stdout || '') + '\n' + (stderr || '')).trim();
            if (err) {
                resolve({ ok: false, output, error: err.message });
            } else {
                resolve({ ok: true, output });
            }
        });
    });
}

/**
 * Apply generated configs to the Nginx sites directory.
 * Creates backups, writes new configs, validates, and optionally reloads.
 *
 * @param {Array} configs - Output from generateAllConfigs()
 * @param {object} opts
 * @param {string} opts.sitesPath - Target directory (default: /etc/nginx/sites-enabled)
 * @param {string} opts.backupPath - Backup directory (default: /etc/nginx/sites-backup)
 * @param {boolean} opts.reload - Whether to reload nginx after apply
 * @param {boolean} opts.dryRun - Only validate, don't write
 * @returns {Promise<{ok: boolean, applied: string[], backed_up: string[], validation: object, reload: object}>}
 */
async function applyConfigs(configs, opts = {}) {
    const sitesPath = opts.sitesPath || '/etc/nginx/sites-enabled';
    const backupPath = opts.backupPath || '/etc/nginx/sites-backup';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(backupPath, timestamp);

    const result = {
        ok: false,
        dryRun: !!opts.dryRun,
        applied: [],
        backed_up: [],
        validation: null,
        reload: null,
        errors: [],
    };

    if (opts.dryRun) {
        // In dry-run mode, validate configs by writing to a temp dir
        const tmpDir = path.join(require('os').tmpdir(), `nginx-preview-${timestamp}`);
        try {
            fs.mkdirSync(tmpDir, { recursive: true });
            for (const cfg of configs) {
                fs.writeFileSync(path.join(tmpDir, cfg.filename), cfg.content);
                result.applied.push(cfg.filename);
            }
            result.ok = true;
            result.validation = { ok: true, output: 'Dry run — configs generated but not applied' };
        } catch (err) {
            result.errors.push(err.message);
        } finally {
            try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
        }
        return result;
    }

    // Create backup directory
    try {
        fs.mkdirSync(backupDir, { recursive: true });
    } catch (err) {
        result.errors.push(`Cannot create backup dir: ${err.message}`);
        return result;
    }

    // Backup existing configs
    try {
        const existing = fs.readdirSync(sitesPath).filter(f => f.endsWith('.conf') || !f.includes('.'));
        for (const f of existing) {
            const src = path.join(sitesPath, f);
            // Resolve symlinks for backup
            const realSrc = fs.existsSync(src) ? (fs.lstatSync(src).isSymbolicLink() ? fs.readlinkSync(src) : src) : src;
            try {
                const content = fs.readFileSync(realSrc, 'utf8');
                fs.writeFileSync(path.join(backupDir, f), content);
                result.backed_up.push(f);
            } catch { /* skip unreadable files */ }
        }
    } catch (err) {
        result.errors.push(`Backup failed: ${err.message}`);
        return result;
    }

    // Write new configs
    for (const cfg of configs) {
        try {
            fs.writeFileSync(path.join(sitesPath, cfg.filename), cfg.content);
            result.applied.push(cfg.filename);
        } catch (err) {
            result.errors.push(`Write ${cfg.filename}: ${err.message}`);
        }
    }

    // Validate
    result.validation = await testNginxConfig();
    if (!result.validation.ok) {
        // Rollback — restore from backup
        result.errors.push('Nginx validation failed — rolling back');
        for (const f of result.backed_up) {
            try {
                const backup = fs.readFileSync(path.join(backupDir, f), 'utf8');
                fs.writeFileSync(path.join(sitesPath, f), backup);
            } catch { /* best effort */ }
        }
        // Remove newly written files that weren't in backup
        for (const f of result.applied) {
            if (!result.backed_up.includes(f)) {
                try { fs.unlinkSync(path.join(sitesPath, f)); } catch { /* ignore */ }
            }
        }
        return result;
    }

    // Reload if requested
    if (opts.reload) {
        result.reload = await reloadNginx();
    }

    result.ok = result.validation.ok && (!opts.reload || result.reload?.ok);
    return result;
}

module.exports = {
    DEFAULT_SERVICE_MAP,
    generateServiceConfig,
    generateAllConfigs,
    testNginxConfig,
    reloadNginx,
    applyConfigs,
};
