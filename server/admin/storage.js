'use strict';
/**
 * The admin panel's Storage tab, cloud part (2026-11-14, the owner's phone).
 *
 *   GET /api/admin/storage/cloud[?force=1]  →  { ok: true, usage, costs }  or  { ok: false, code, detail }
 *
 * The tab used to ask OpenVibe.Live, which asked OpenVibe.Media with Live's own service token. Media keeps its
 * storage console for the app key it owns and refuses service tokens there, so the scan came back
 * "service tokens are not accepted on this route" and the panel showed that sentence to the owner.
 *
 * Network asks Media itself now, the way the owner settings proxy asks a service
 * (server/admin/ai-config-proxy.js): Network's own service token for openvibe.media and the owner's usr_ in
 * X-OV-Subject. When Media refuses that as well, this route says so in words the owner can act on — the disk
 * numbers in the tab stay true, and the cloud usage is on the provider's own billing page.
 *
 * Nothing is stored here: the answer is relayed and dropped.
 *
 * test/admin-storage-cloud.test.js
 */
const express = require('express');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MEDIA_AUDIENCE = 'openvibe.media';
const MEDIA_CAPABILITY = 'media.object.read';
const MEDIA_TENANT = 'live';
const TIMEOUT_MS = 20000;

/** The words the panel shows when the scan did not run. */
const NO_SCAN = 'The cloud scan did not run. The disk numbers above are current; the cloud usage is on the provider\'s own billing page.';

function router({ selfToken, services } = {}) {
    const r = express.Router();

    r.get('/cloud', async (req, res) => {
        const service = (services && services.media) || {};
        const base = String(service.internalUrl || '').replace(/\/+$/, '');
        if (!base) {
            return res.json({ ok: false, code: 'media.not_configured', detail: 'OpenVibe.Media is not configured on this host, so the cloud scan cannot run. ' + NO_SCAN });
        }
        const subject = String((req.user && req.user.subject_id) || '');
        if (!SUBJECT_RE.test(subject)) {
            return res.json({ ok: false, code: 'actor.required', detail: 'The cloud scan runs for the owner account only.' });
        }
        let token = null;
        try { token = typeof selfToken === 'function' ? selfToken(MEDIA_AUDIENCE, [MEDIA_CAPABILITY]) : null; } catch { token = null; }
        if (!token) {
            return res.json({ ok: false, code: 'token.unavailable', detail: 'Network cannot mint a token for OpenVibe.Media, so the cloud scan cannot run. ' + NO_SCAN });
        }
        const url = base + '/api/v1/' + MEDIA_TENANT + '/admin/storage/buckets' + (req.query.force ? '?force=1' : '');
        let upstream;
        try {
            upstream = await fetch(url, {
                method: 'GET',
                headers: { accept: 'application/json', authorization: 'Bearer ' + token, 'x-ov-subject': subject },
                redirect: 'error',   // a service's answer is the answer: never follow it to another address
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch {
            return res.json({ ok: false, code: 'media.unavailable', detail: 'OpenVibe.Media did not answer the cloud scan. ' + NO_SCAN });
        }
        const text = await upstream.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        if (upstream.status < 200 || upstream.status >= 300) {
            const said = body && (body.detail || body.error) ? String(body.detail || body.error).slice(0, 200) : null;
            return res.json({
                ok: false,
                code: (body && body.code) || 'media.refused',
                detail: 'OpenVibe.Media did not answer the cloud scan' + (said ? ': ' + said : '.') + ' ' + NO_SCAN,
            });
        }
        res.json({
            ok: true,
            usage: (body && body.usage) || {},
            costs: (body && body.costs) || {},
            checked_at: (body && body.checkedAt) || null,
        });
    });

    return r;
}

module.exports = { router, MEDIA_AUDIENCE, MEDIA_CAPABILITY, MEDIA_TENANT, NO_SCAN };
