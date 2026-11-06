'use strict';
/**
 * Who is calling the gateway (the MCP server and the pages behind it).
 *
 * Three kinds of caller, one person behind each:
 *
 *   the person's own session token      the person is signed in (the Apps page, their own scripts)
 *   a key the person made               one caller of their own (their Claude Code, a script on their
 *                                        laptop). The key is ovc_<id>_<secret>; only its hash is kept.
 *   a service token that names a person  a service acting for them (Codes, Actor): the token carries
 *                                        on_behalf_of, and the caller is the service.
 *
 * -> { ok: true, subject, caller, kind } | { ok: false, status, code, detail }
 */
const { serviceAuth } = require('openvibe-contracts');
const { verifySession } = require('../auth/session');
const callers = require('./callers');

const bearer = (req) => {
    const h = String(req.headers.authorization || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

async function resolveCaller(db, req, { config, publicKey, issuer } = {}) {
    const token = bearer(req);
    if (!token) return { ok: false, status: 401, code: 'connect.unauthenticated', detail: 'a token is needed' };

    // A key the person made on the Apps page.
    if (token.startsWith(callers.KEY_PREFIX)) {
        const row = await callers.findByKey(db, token);
        if (!row) return { ok: false, status: 401, code: 'connect.unauthenticated', detail: 'that key is not known' };
        return { ok: true, subject: row.subject, caller: row, kind: 'key' };
    }

    // A service token that names a person.
    if (token.split('.').length === 3 && publicKey) {
        const v = serviceAuth.verifyServiceToken(token, { publicKey, issuer: issuer || (config && config.jwt && config.jwt.issuer), audience: 'openvibe.network' });
        if (v.ok && v.claims.on_behalf_of) {
            const person = String(v.claims.on_behalf_of);
            const service = String(v.claims.sub || '').replace(/^svc:/, '') || 'service';
            const row = await callers.ensureServiceCaller(db, person, service, service);
            return { ok: true, subject: person, caller: row, kind: 'service', service };
        }
    }

    // The person's own session.
    if (publicKey && config) {
        const out = await verifySession(token, { db, publicKey, config });
        if (!out.error) {
            const subject = out.user.subject_id || out.user.subject || String(out.user.id);
            const row = await callers.ensurePersonCaller(db, subject, out.user.display_name || out.user.username || 'You');
            return { ok: true, subject, caller: row, kind: 'person', user: out.user };
        }
    }

    return { ok: false, status: 401, code: 'connect.unauthenticated', detail: 'that token is not accepted here' };
}

module.exports = { resolveCaller, bearer };
