'use strict';
/**
 * Who follows a Live channel — asked of OpenVibe.Live, which owns the follow graph (its `follows`
 * table, keyed by Live user ids). Network never keeps a copy: it reads the list when a
 * live.stream.started event arrives and turns it into notifications.
 *
 *   GET <live>/internal/followers?stream_id=<id>&limit=<n>[&after=<cursor>]
 *   Authorization: Bearer <service token: sub svc:network, aud openvibe.live, cap live.follower.read>
 *
 *   200 { stream_id, channel: { subject }, followers: [{ subject, network_user_id }], next }
 *   404 { code: 'live.unknown_stream' }   the stream row does not exist (nothing to announce)
 *
 * Network is the token issuer, so it signs its own 5-minute token (as for OpenVibe.AI and Events).
 * Live verifies it with the Network key it already verifies user JWTs with (server/net/service-guard.js
 * there) and serves the route on loopback only.
 */
const crypto = require('crypto');

const CAPABILITY = 'live.follower.read';
const PAGE = 5000;
const MAX = 50000;

class LiveFollowersError extends Error {}

function createLiveFollowers({ privateKey, issuer, liveUrl, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
    const base = String(liveUrl || '').replace(/\/+$/, '');
    let cached = null;
    function token() {
        const { serviceAuth } = require('openvibe-contracts');
        const now = Math.floor(Date.now() / 1000);
        if (cached && cached.exp - 60 > now) return cached.token;
        const claims = { iss: issuer, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.live'], cap: [CAPABILITY], iat: now, exp: now + 300, jti: `tok_${crypto.randomBytes(12).toString('hex')}` };
        cached = { token: serviceAuth.signServiceToken(claims, privateKey), exp: claims.exp };
        return cached.token;
    }

    /**
     * Every follower of the channel that streams `streamId`: { channelSubject, followers: [{ subject, network_user_id }], truncated }
     * or { missing: true } when Live has no such stream. Throws LiveFollowersError when Live cannot
     * answer (down, route not deployed, token refused): the delivery is then retried by Events.
     */
    async function forStream(streamId) {
        if (!base || !privateKey || !issuer) throw new LiveFollowersError('Live followers client is not configured');
        const followers = [];
        let after = null; let channelSubject; let truncated = false;
        for (;;) {
            const qs = new URLSearchParams({ stream_id: String(streamId), limit: String(PAGE) });
            if (after != null) qs.set('after', String(after));
            let res;
            try {
                res = await fetchImpl(`${base}/internal/followers?${qs}`, { headers: { Authorization: `Bearer ${token()}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
            } catch (err) {
                throw new LiveFollowersError(`Live unreachable: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
            }
            const body = await res.json().catch(() => null);
            if (res.status === 404 && body && body.code === 'live.unknown_stream') return { missing: true };
            if (res.status === 401) cached = null;
            if (!res.ok || !body || !Array.isArray(body.followers)) throw new LiveFollowersError(`Live answered ${res.status}${body && body.code ? ` ${body.code}` : ''}`);
            const subj = body.channel && typeof body.channel.subject === 'string' ? body.channel.subject : null;
            if (channelSubject === undefined) channelSubject = subj;
            for (const f of body.followers) {
                if (!f || typeof f !== 'object') continue;
                followers.push({ subject: typeof f.subject === 'string' ? f.subject : null, network_user_id: Number.isInteger(f.network_user_id) && f.network_user_id > 0 ? f.network_user_id : null });
            }
            if (followers.length >= MAX) { truncated = body.next != null; followers.length = Math.min(followers.length, MAX); break; }
            if (body.next == null || body.next === after || !body.followers.length) break;
            after = body.next;
        }
        return { channelSubject, followers, truncated };
    }

    return { forStream, enabled: !!(base && privateKey && issuer) };
}

module.exports = { createLiveFollowers, LiveFollowersError, CAPABILITY };
