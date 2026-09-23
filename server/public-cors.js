'use strict';
/**
 * Public, CORS-open discovery (roadmap Wave 20): any origin may read the platform descriptor, the
 * ecosystem registry and the contract schemas, so a plain browser page can discover services
 * without a server of its own.
 *
 *   GET /.well-known/openvibe
 *   GET /api/v1/registry and /api/v1/registry/<...>
 *   GET /contracts/<domain>/<name>.v<N>.json
 *
 * These answer every origin, preflight included, with `Access-Control-Allow-Origin: *` and no
 * credentials (cookies are never needed and never sent). Every other route keeps the first-party
 * allow-list: gate() sends everything else to the restricted cors() middleware unchanged.
 */

const ALLOW_HEADERS = 'traceparent, X-OpenVibe-Request-Id, Authorization, Content-Type';
const EXPOSE_HEADERS = 'X-OpenVibe-Request-Id, traceparent';
const MAX_AGE_S = 86400;

// A registry segment: URL-safe characters, never '.' or '..' and never an encoded dot or slash.
const SEGMENT_RE = /^[A-Za-z0-9_~:@!$&'()*+,;=.-]+$/;
const CONTRACT_RE = /^\/contracts\/[a-z0-9-]+\/[a-z0-9-]+\.v\d+\.json$/;

function isPublicDiscoveryPath(p) {
    const path = String(p || '');
    if (path === '/.well-known/openvibe') return true;
    if (CONTRACT_RE.test(path)) return true;
    if (path === '/api/v1/registry' || path === '/api/v1/registry/') return true;
    if (!path.startsWith('/api/v1/registry/')) return false;
    const segments = path.slice('/api/v1/registry/'.length).replace(/\/$/, '').split('/');
    return segments.every(s => SEGMENT_RE.test(s) && s !== '.' && s !== '..' && !/%2e|%2f|%5c/i.test(s));
}

/** Headers for a public discovery response; a preflight is answered here with 204. */
function publicCors(req, res, next) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', EXPOSE_HEADERS);
    // Helmet's default same-origin resource policy would stop other sites from reading these.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
        res.setHeader('Access-Control-Max-Age', String(MAX_AGE_S));
        res.statusCode = 204;
        res.setHeader('Content-Length', '0');
        return res.end();
    }
    return next();
}

/** One CORS middleware for the app: public discovery paths open, everything else `restricted`. */
function gate(restricted) {
    return function corsGate(req, res, next) {
        if (isPublicDiscoveryPath(req.path)) return publicCors(req, res, next);
        return restricted(req, res, next);
    };
}

module.exports = { gate, publicCors, isPublicDiscoveryPath, ALLOW_HEADERS, EXPOSE_HEADERS };
