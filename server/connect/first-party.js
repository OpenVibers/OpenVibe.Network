'use strict';
/**
 * OpenVibe's own apps in Connect (2026-11-18; plan §AD.28 item 2; the owner: "Do it way better and improved on"). An
 * Apps-page key, or anything else the person allowed, may use the person's own tools on Design and Vision through
 * /mcp/all, as the person, without ever holding their account:
 *
 * - **A grant, like any app.** OpenVibe Design and OpenVibe Vision are always connected (they are the person's own
 *   account), so a key needs only a grant in them: read, or read and write. Without one, a key reaches only their public
 *   tools, anonymously, as before.
 * - **read** lists and calls only the tools a server marks readOnlyHint. **write** calls the rest. A tool marked
 *   destructiveHint asks the person first (approvals.js), unless they told that app and tool it need not ask again.
 * - **A delegated person token per call** (SDK 0.187, openvibe-sdk/auth/delegated): the person, never staff, for this
 *   one service (svc), naming the key that acts (act), with the grant as its scope, for ten minutes. It goes to that
 *   service's /mcp only; the script never sees it, and the services take it on /mcp only.
 * - Each call is written to the Connect log, like an action.
 *
 *   FIRST_PARTY                          { design: { name, services }, vision: … }
 *   createFirstParty({ db, privateKey, issuer, approvals, writeLog, now })
 *     grantOf(who, app)                   → 'read' | 'write' | null
 *     token(who, app, scope)              → a signed delegated token, or null (no RS256 key, or no such person)
 *     ask(who, app, tool, input)          → { ok } | { ok: false, error }
 *     log(who, app, tool, risk, ok, status)
 */
const jwt = require('jsonwebtoken');
const callers = require('./callers');

const FIRST_PARTY = Object.freeze({
    design: Object.freeze({ name: 'OpenVibe Design', services: ['design'], blurb: 'Make typefaces and vectors and audit pages, as you.' }),
    vision: Object.freeze({ name: 'OpenVibe Vision', services: ['vision'], blurb: 'Search your own media and look at your images and clips, as you.' }),
    // Tools checks its own audience (openvibe.tools), not the Network sign-in's (Tools #414, 11-18).
    tools: Object.freeze({ name: 'OpenVibe Tools', services: ['tools'], audience: ['openvibe.tools'], blurb: 'Run the tools that need you, your own made tools and your automations, as you, paid from your allowance.' }),
});
const isFirstParty = (app) => Object.prototype.hasOwnProperty.call(FIRST_PARTY, String(app || ''));
const TTL_SEC = 600;

function createFirstParty({ db, privateKey, issuer, approvals, writeLog = null, approvalWaitMs, now = () => Date.now(), log = console } = {}) {
    const canSign = !!(privateKey && String(privateKey).includes('BEGIN') && issuer);

    async function grantOf(who, app) {
        if (!who || !who.caller || !isFirstParty(app)) return null;
        return callers.grantOf(db, who.caller.id, app);
    }

    async function person(subject) {
        const user = await db.prepare('SELECT * FROM users WHERE subject_id = ?').get(String(subject || ''));
        if (!user || user.is_banned || user.merged_into || user.deleted_at) return null;
        return user;
    }

    async function token(who, app, scope) {
        if (!canSign || !isFirstParty(app)) return null;
        const user = await person(who.subject);
        if (!user) return null;
        const { delegatedClaims } = require('openvibe-sdk/auth/delegated');
        const claims = delegatedClaims({
            user: { id: user.id, subject_id: user.subject_id, username: user.username, display_name: user.display_name, avatar_url: user.avatar_url },
            by: String(who.caller.id), services: FIRST_PARTY[app].services, scope: scope === 'write' ? 'write' : 'read',
            ttlSec: TTL_SEC, issuer, audience: FIRST_PARTY[app].audience || ['openvibe.network'], now: now(),
        });
        for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
        return jwt.sign(claims, privateKey, { algorithm: 'RS256' });
    }

    /** A destructive tool asks the person first, unless they said that app and tool need not ask again. */
    async function ask(who, app, tool, input) {
        const action = `${app}.${tool}`;
        const rules = await approvals.rulesOf(db, who.subject);
        if (rules.has(`${app}.${action}`) || rules.has(action)) return { ok: true };
        const def = { key: app, name: FIRST_PARTY[app].name };
        const approval = await approvals.request(db, {
            subject: who.subject, callerId: who.caller.id, app, action,
            summary: approvals.summaryOf(def, { name: action, title: `${tool} in ${FIRST_PARTY[app].name}` }, input || {}), input: input || {},
        });
        const decided = await approvals.wait(db, approval.id, approvalWaitMs ? { timeoutMs: approvalWaitMs } : {});
        if (decided.state === 'approved') return { ok: true };
        return { ok: false, error: decided.state === 'denied' ? 'the person said no' : 'the person has not approved this yet: they decide on the Apps page' };
    }

    async function logCall(who, app, tool, risk, ok, status = null) {
        if (!writeLog) return;
        try {
            await writeLog({ subject: who.subject, callerId: who.caller.id, callerName: who.caller.name, app, action: `${app}.${tool}`, risk, ok, status, errorCode: ok ? null : 'connect.first_party_failed' });
        } catch (err) { if (log && log.warn) log.warn(`[connect] the log of ${app}.${tool} was not written: ${err && err.message}`); }
    }

    return { grantOf, token, ask, log: logCall, canSign };
}

module.exports = { FIRST_PARTY, isFirstParty, createFirstParty };
