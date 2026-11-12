'use strict';
/**
 * A caption for a picture, in any composer (the owner, 2026-11-12: "it'll auto caption using OpenVibe.Exchange, using
 * the AI features … like some Instagram shit"):
 *
 *   POST /api/frame/caption { image: { data_url }, title? }  → 200 { alt, caption, tags }
 *
 * Signed in only, and the person's own token pays (AI's free allowance, their Balance, or their own key or computer),
 * exactly as Ask does. The picture goes to AI's pics.describe_image workflow (alt text of at most 140 characters, a
 * one or two sentence caption, up to six tags) and nothing is kept here: AI keeps only the image's hash. The composer
 * sends a small JPEG (its long side 768 px, about 100-200 KB), well under the app's 1 MB JSON limit.
 */
const express = require('express');

const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,4096}$/;
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_DATA_URL = 950_000;   // under the app's 1 MB JSON parser (server/index.js)

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** The request's body, or { error }: one picture as a data URL, and an optional title to steer the words. */
function readCaption(body) {
    const b = body && typeof body === 'object' ? body : {};
    const url = b.image && typeof b.image === 'object' ? String(b.image.data_url || '') : '';
    if (!url) return { error: 'Send the picture as image.data_url' };
    if (url.length > MAX_DATA_URL) return { error: 'The picture is too large to describe: send it at most 768 px on its long side' };
    if (!DATA_URL_RE.test(url)) return { error: 'The picture must be a JPEG, PNG or WebP data URL' };
    return { dataUrl: url, title: clean(b.title, 120) };
}

function createFrameCaption({ aiUrl = 'http://127.0.0.1:4700', requireAuth = null, fetchImpl = globalThis.fetch, now = Date.now, perMinute = 20, timeoutMs = 45_000 } = {}) {
    const aiBase = String(aiUrl || '').replace(/\/+$/, '');
    const guard = typeof requireAuth === 'function' ? requireAuth : (_req, res) => res.status(401).json({ error: 'Sign in to caption a picture' });
    const asks = new Map();   // subject -> [timestamps]

    const subjectOf = (req) => {
        const user = req.user || {};
        const claims = req.tokenClaims || {};
        const id = user.subject_id || user.subject || claims.subject_id || claims.sub || user.sub;
        return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || '')) ? String(id) : null;
    };
    const bearerOf = (req) => {
        const m = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || ''));
        const t = m ? m[1] : (req.token || '');
        return TOKEN_RE.test(String(t || '')) ? String(t) : null;
    };
    function allowed(subject) {
        const at = now();
        const list = (asks.get(subject) || []).filter((t) => at - t < 60_000);
        if (list.length >= perMinute) { asks.set(subject, list); return false; }
        list.push(at); asks.set(subject, list);
        if (asks.size > 5000) asks.clear();
        return true;
    }

    const caption = [guard, express.json({ limit: '1mb' }), async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        const subject = subjectOf(req);
        const token = bearerOf(req);
        if (!subject || !token) return res.status(401).json({ error: 'Sign in to caption a picture', code: 'frame.sign_in' });
        const body = readCaption(req.body);
        if (body.error) return res.status(422).json({ error: body.error, code: 'frame.caption_invalid' });
        if (!allowed(subject)) { res.set('Retry-After', '60'); return res.status(429).json({ error: 'Too many captions just now: try again in a minute', code: 'frame.rate_limited' }); }
        let r;
        try {
            r = await fetchImpl(`${aiBase}/api/v1/runs?wait=${timeoutMs - 5000}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}`, ...(req.ip ? { 'X-Forwarded-For': req.ip } : {}) },
                body: JSON.stringify({ workflow: 'pics.describe_image', input: { image: { data_url: body.dataUrl }, ...(body.title ? { title: body.title } : {}) } }),
                redirect: 'manual',
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch {
            return res.status(504).json({ error: 'The AI did not answer in time: try again', code: 'frame.caption_timeout' });
        }
        const out = await r.json().catch(() => null);
        if (!r.ok) {
            const status = r.status === 402 || r.status === 403 || r.status === 429 ? r.status : 502;
            if (r.status === 429) res.set('Retry-After', String(r.headers.get('retry-after') || '60'));
            return res.status(status).json({ error: (out && (out.detail || out.error)) || 'The AI could not describe the picture', code: (out && out.code) || 'frame.caption_failed' });
        }
        const run = out && out.run;
        const o = run && run.output;
        if (!o || typeof o !== 'object' || (!o.alt && !o.caption)) {
            const pending = run && !['succeeded', 'failed', 'cancelled'].includes(String(run.status));
            return res.status(pending ? 504 : 502).json({ error: pending ? 'The AI is still describing it: try again in a moment' : 'The AI could not describe the picture', code: 'frame.caption_failed' });
        }
        const tags = Array.isArray(o.tags) ? o.tags.map((t) => clean(t, 30)).filter(Boolean).slice(0, 6) : [];
        return res.json({ alt: clean(o.alt, 160), caption: clean(o.caption, 400), tags });
    }];

    return { caption };
}

module.exports = { createFrameCaption, readCaption };
