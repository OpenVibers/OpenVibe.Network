'use strict';
/**
 * POST /api/frame/speech — words read aloud in an OpenVibe voice (openvibe-shared 4.308.0 ov-speak.js, "OpenVibe
 * voices"; the owner, 2026-11-17: "a feature for the sessions and codes and actor and etc where it will read out it's
 * messages using text to speech if configured").
 *
 *   { text, voice?, speed? } → the audio (audio/mpeg)
 *
 * The signed-in person's words (at most 1,000 characters a request: ov-speak sends a sentence or two at a time) go to
 * OpenVibe.AI's POST /v1/audio/speech with the Frame's own service token, on behalf of the person, so their free AI
 * allowance pays and then their Balance, by the character, as AI meters it. Nothing is kept. A person may ask 120
 * times a minute. A voice is one of AI's voice ids (AI refuses one it does not know: never another voice in its place).
 */
const crypto = require('crypto');

const VOICE = /^[a-z][a-z0-9_]{1,40}$/;
const DEFAULT_VOICE = 'gc_wave_queen';
const MAX_TEXT = 1000;
const PER_MINUTE = 120;

function createSpeech({ privateKey, issuer, aiUrl, fetchImpl = globalThis.fetch, now = Date.now, log = console } = {}) {
    let cached = null;
    function token() {
        const t = Math.floor(now() / 1000);
        if (cached && cached.exp - 60 > t) return cached.token;
        const { serviceAuth } = require('openvibe-contracts');
        const claims = { iss: issuer, sub: 'svc:network', actor_type: 'service', aud: ['openvibe.ai'], cap: ['ai.run.create'], ns: ['network.*'], iat: t, exp: t + 300, jti: `tok_${crypto.randomBytes(8).toString('hex')}` };
        cached = { token: serviceAuth.signServiceToken(claims, privateKey), exp: claims.exp };
        return cached.token;
    }
    const asked = new Map();   // subject → { at, n }: the requests of the last minute
    function room(subject) {
        const t = now();
        const a = asked.get(subject);
        if (!a || t - a.at >= 60000) { asked.set(subject, { at: t, n: 1 }); if (asked.size > 5000) asked.delete(asked.keys().next().value); return true; }
        a.n += 1;
        return a.n <= PER_MINUTE;
    }

    /** → { audio: Buffer, type } or { status, error } */
    async function speak({ subject, text, voice, speed }) {
        const words = typeof text === 'string' ? text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim() : '';
        if (!words) return { status: 400, error: 'text is the words to read' };
        if (words.length > MAX_TEXT) return { status: 413, error: `at most ${MAX_TEXT} characters a request` };
        const v = voice == null || voice === '' ? DEFAULT_VOICE : String(voice);
        if (!VOICE.test(v)) return { status: 400, error: 'voice is one of OpenVibe\'s voice ids' };
        const s = speed == null ? 1 : Number(speed);
        if (!Number.isFinite(s) || s < 0.5 || s > 2) return { status: 400, error: 'speed is 0.5 to 2' };
        if (!room(subject)) return { status: 429, error: 'Too many requests to read aloud: try again in a minute' };
        let r;
        try {
            r = await fetchImpl(`${String(aiUrl).replace(/\/+$/, '')}/v1/audio/speech`, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
                headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
                body: JSON.stringify({ model: 'tts-1', input: words, voice: v, response_format: 'mp3', speed: s, on_behalf_of: { type: 'user', id: subject } }),
            });
        } catch (err) {
            if (log.warn) log.warn(`[speech] AI did not answer: ${err && err.message}`);
            return { status: 502, error: 'The voice did not answer; try again in a moment' };
        }
        if (!r.ok) {
            const j = await r.json().catch(() => null);
            const said = j && j.error && j.error.message ? String(j.error.message).slice(0, 300) : null;
            // The allowance and the Balance are the person's own story: said in words; anything else is the voice's fault.
            if (r.status === 402 || r.status === 429) return { status: r.status, error: said || (r.status === 402 ? 'Your free AI is used up: OpenVibe voices need your Balance' : 'Too many requests to read aloud') };
            if (r.status === 400) return { status: 400, error: said || 'That voice cannot read this' };
            if (log.warn) log.warn(`[speech] AI answered ${r.status}`);
            return { status: 502, error: 'The voice did not answer; try again in a moment' };
        }
        const audio = Buffer.from(await r.arrayBuffer());
        if (!audio.length) return { status: 502, error: 'The voice gave no sound' };
        return { audio, type: /^audio\/[a-z0-9.+-]+$/i.test(String(r.headers.get('content-type') || '')) ? r.headers.get('content-type') : 'audio/mpeg' };
    }
    return { speak };
}

module.exports = { createSpeech, DEFAULT_VOICE, MAX_TEXT };
