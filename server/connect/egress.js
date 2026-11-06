'use strict';
/**
 * The one way out of the gateway: a request to the app's own API host, through openvibe-shared/egress.
 *
 * The host is fixed by the app definition, never taken from the input. Three rules hold here:
 *
 *   1. An IP literal is refused before the socket is opened. Node does not call a custom lookup for
 *      a literal, so the guard would never see it: isPublicAddress(normalizeHost(host)) decides.
 *      (The same check is false for a name, which is not an address, so the literal case is the one
 *      that applies.)
 *   2. A name resolves only to public addresses: the lookup is openvibe-shared/egress's safeLookup,
 *      which fails unless every answer is public, so the socket connects to the checked address and
 *      a rebinding cannot slip a private one in.
 *   3. A redirect is followed by hand and every hop is checked again: the new host must still be the
 *      app's own host, and the new URL must pass the guard again. A redirect off the app's host is
 *      refused.
 *
 * The answer is at most MAX_BYTES, and the request has a timeout.
 */
const https = require('https');
const net = require('net');
const { isPublicAddress, normalizeHost, isInternalName, createSafeLookup, safeLookup } = require('openvibe-shared/egress');

const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15000;

class ConnectError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; this.detail = detail || code; }
}
const denied = (detail) => { throw new ConnectError(403, 'connect.egress_denied', detail); };

/** The host of an app definition, checked. */
function hostOf(def) {
    const host = normalizeHost(def && def.apiHost);
    if (!host) denied('this app has no API host');
    if (net.isIP(host)) {
        // A literal: Node does not call a custom lookup for it, so it is checked here.
        if (!isPublicAddress(normalizeHost(host))) denied(`${host} is not a public address`);
        return host;
    }
    if (isInternalName(host)) denied(`${host} is not a public host name`);
    return host;
}

/** The URL of one request: the fixed host, the fixed path, the query the definition asks for. */
function urlFor(def, { path: requestPath, query }) {
    const host = hostOf(def);
    const url = new URL(`https://${host}${requestPath}`);
    for (const [name, value] of Object.entries(query || {})) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(name, String(value));
    }
    return url;
}

/** One https request with the guard's lookup, a timeout and a size cap. */
function send(url, { method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS, lookup, isAllowed, tls = null } = {}) {
    const look = lookup ? createSafeLookup({ lookup, isAllowed }) : undefined;
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search,
            method, headers, ...(look ? { lookup: look } : {}), servername: url.hostname, ...(tls || {}),
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                size += c.length;
                if (size > MAX_BYTES) { req.destroy(); reject(new ConnectError(502, 'connect.answer_too_large', 'the app answered more than 256 KB')); return; }
                chunks.push(c);
            });
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', (e) => reject(e));
        });
        req.setTimeout(timeoutMs, () => { req.destroy(new ConnectError(504, 'connect.timeout', 'the app did not answer in time')); });
        req.on('error', (e) => reject(e));
        if (body !== null && body !== undefined) req.write(body);
        req.end();
    });
}

/**
 * The URL passes the guard: https, no credentials in it, and a name that resolves only to public
 * addresses. The lookup is openvibe-shared/egress's own, so the socket connects to the checked
 * address and a rebinding cannot slip a private one in. A test may inject its own resolver.
 */
async function checkUrl(url, { lookup, isAllowed } = {}) {
    if (url.protocol !== 'https:') denied('only https is called');
    if (url.username || url.password) denied('credentials in the URL are not allowed');
    const look = lookup ? createSafeLookup({ lookup, isAllowed }) : safeLookup;
    await new Promise((resolve, reject) => look(url.hostname, { all: true }, (e) => (e ? reject(e) : resolve())));
}

/**
 * The request the gateway makes. -> { status, headers, body, url }.
 * The redirect is not followed by the http client: every hop is checked here.
 */
async function request(def, { method = 'GET', path: requestPath, query = {}, headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS, lookup, isAllowed, tls = null } = {}) {
    let url = urlFor(def, { path: requestPath, query });
    let hops = 0;
    for (;;) {
        // The guard's own check: the scheme, the name and every address it resolves to.
        await checkUrl(url, { lookup, isAllowed });
        const res = await send(url, { method, headers, body, timeoutMs, lookup, isAllowed, tls });
        const location = res.headers && res.headers.location;
        if (![301, 302, 303, 307, 308].includes(res.status) || !location) {
            return { ...res, url: url.toString(), redirects: hops };
        }
        if (hops >= MAX_REDIRECTS) throw new ConnectError(502, 'connect.too_many_redirects', 'the app redirected too many times');
        let next;
        try { next = new URL(location, url); } catch { throw new ConnectError(502, 'connect.bad_redirect', 'the app redirected somewhere unreadable'); }
        // A redirect off the app's own host is refused: the credential never travels there.
        if (normalizeHost(next.hostname) !== normalizeHost(url.hostname)) {
            denied(`the app redirected to ${next.hostname}, which is not its own host`);
        }
        url = next;
        hops += 1;
    }
}

module.exports = { request, urlFor, hostOf, checkUrl, ConnectError, MAX_BYTES, MAX_REDIRECTS, DEFAULT_TIMEOUT_MS };
