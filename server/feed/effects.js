'use strict';

/**
 * The name effect a person wears (feed.item@1 1.1.0, actor.fx): the token OpenVibe.Inventory holds
 * for them, such as "name-fx-rainbow". The feed's own server asks for it, so no site needs Inventory
 * in its connect-src; openvibe-shared items.css draws it.
 *
 *   GET <inventory>/api/v1/equipped?subjects=usr_…,usr_…   up to 100 people in one call, no credentials
 *   → { equipped: [{ subject, slots: { "live.name_effect:effect": { token: "name-fx-rainbow" } } }] }
 *
 * One answer is kept 60 s, so a page full of names costs one or two requests. Inventory down, slow or
 * unreachable never blocks the feed: the cards come without an effect, and the failure is remembered
 * for the same minute, so the feed does not wait on it again and again.
 */
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const NAME_FX = /^name-fx-[a-z]{2,24}$/;
const KIND = 'live.name_effect';
const BATCH = 100;
const TTL_MS = 60 * 1000;

function createEffects({ baseUrl = '', fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 1500 } = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const cache = new Map();      // subject → { at, token }

    /** The token a set wears, or null: only a token of the known shape becomes one. */
    function tokenOf(slots) {
        let token = null;
        for (const [key, value] of Object.entries(slots || {})) {
            if (String(key).split(':')[0] !== KIND) continue;
            if (value && NAME_FX.test(String(value.token || ''))) token = String(value.token);
        }
        return token;
    }

    async function fetchSets(subjects) {
        const res = await fetchImpl(`${base}/api/v1/equipped?subjects=${subjects.map(encodeURIComponent).join(',')}`, {
            headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`Inventory answered ${res.status}`);
        const body = await res.json();
        const got = new Map();
        for (const set of (body && body.equipped) || []) {
            if (!set || !SUBJECT.test(String(set.subject || ''))) continue;
            got.set(String(set.subject), tokenOf(set.slots));
        }
        return got;
    }

    /** The name effect of each subject asked for: Map(subject → token | null). Never throws. */
    async function effects(subjects) {
        const want = [...new Set((subjects || []).map(String))].filter((s) => SUBJECT.test(s));
        if (!want.length || !base) return new Map();
        const at = now();
        const missing = want.filter((s) => { const hit = cache.get(s); return !hit || at - hit.at > TTL_MS; });
        for (let i = 0; i < missing.length; i += BATCH) {
            const chunk = missing.slice(i, i + BATCH);
            try {
                const got = await fetchSets(chunk);
                for (const s of chunk) cache.set(s, { at: now(), token: got.get(s) || null });
            } catch {
                // Inventory is not answering: the names come without an effect, and the answer is
                // remembered for a minute, so the feed does not wait on it again straight away.
                for (const s of chunk) if (!cache.has(s)) cache.set(s, { at: now(), token: null });
            }
        }
        return new Map(want.map((s) => [s, (cache.get(s) || { token: null }).token]));
    }

    return { effects };
}

module.exports = { createEffects, TTL_MS, BATCH };
