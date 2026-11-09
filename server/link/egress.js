'use strict';

// Run is authoritative for session ownership; Network is authoritative for device ownership.
// Session credentials are random, short lived, stored only as hashes, and rechecked on EVERY open.
const crypto = require('crypto');
const express = require('express');
const { http } = require('openvibe-contracts');
const { ensureUserSubject } = require('../identity/subjects');
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;
const MACHINE = /^dev_[0-9A-HJKMNP-TV-Z]{26}$/;
const NODE = /^lnk_[0-9A-HJKMNP-TV-Z]{26}$/;
const DESK = /^desk-[a-z0-9][a-z0-9-]{0,23}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_BYTES = 20_000_000_000;
const EXPLANATION = "Your Actor's browsing on OpenVibe computers goes out through this computer's internet, so sites see your usual address.";
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (status, code) => Object.assign(new Error(code), { status, code: `egress.${code}` });
const wrap = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await fn(req, res); } catch (e) {
        http.sendProblem(res, e.status || 503, e.code || 'egress.unavailable', { detail: 'Your browsing connection is unavailable.' });
    }
};

async function settings(db, owner) {
    const row = await db.prepare('SELECT * FROM link_egress_settings WHERE owner_subject = ?').get(owner);
    return row ? { egress_via_link: row.egress_via_link, offline_choice: row.offline_choice,
        monthly_bytes: Number(row.monthly_bytes), excluded_sites: row.excluded_sites } :
        { egress_via_link: true, offline_choice: 'openvibe', monthly_bytes: DEFAULT_BYTES, excluded_sites: [] };
}

function validateSettings(body) {
    if (!body || typeof body.egress_via_link !== 'boolean' || !['openvibe', 'wait'].includes(body.offline_choice) ||
        !Number.isSafeInteger(body.monthly_bytes) || body.monthly_bytes < 0 || body.monthly_bytes > 10_000_000_000_000 ||
        !Array.isArray(body.excluded_sites) || body.excluded_sites.length > 100) throw fail(422, 'invalid_settings');
    const sites = body.excluded_sites.map(s => typeof s === 'string' ? s.trim().toLowerCase() : '');
    if (sites.some(s => s.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s))) throw fail(422, 'invalid_site');
    return { ...body, excluded_sites: [...new Set(sites)] };
}

async function node(db, id) {
    if (!NODE.test(id || '')) throw fail(403, 'node_required');
    const row = await db.prepare('SELECT id, owner_kind, owner_subject, status, name, pairing_ref, paired_by_service FROM platform_node_principals WHERE id = ?').get(id);
    if (!row || row.status !== 'active') throw fail(403, 'node_unavailable');
    return row;
}
async function ownNode(db, req) {
    if (!String(req.principal?.sub).startsWith('link:')) throw fail(403, 'node_required');
    return node(db, req.principal.sub.slice(5));
}

async function cloudMachine(bot, principal) {
    if (principal.paired_by_service !== 'bot' || principal.owner_kind !== 'user') throw fail(403, 'node_required');
    // Pairing refs identify a robot or worker group, not a dev_ machine. Bot owns this binding.
    const machines = (await bot.list(principal.owner_subject)).machines || [];
    const machine = machines.find(m => m.node_id === principal.id && MACHINE.test(m.id || ''));
    if (!machine) throw fail(403, 'node_unavailable');
    return machine.id;
}

async function selectRoute(db, owner, now = Date.now()) {
    const prefs = await settings(db, owner);
    const devices = await db.prepare(`SELECT n.id, n.name, d.relay_url, d.checked_at FROM platform_node_principals n
        LEFT JOIN link_egress_devices d ON d.node_id = n.id
        WHERE n.owner_kind = 'user' AND n.owner_subject = ? AND n.status = 'active'
        ORDER BY d.checked_at DESC NULLS LAST, n.id`).all(owner);
    if (!prefs.egress_via_link || !devices.length) return { mode: 'direct', ...prefs };
    const online = devices.find(d => Number(d.checked_at) > now - 45_000);
    if (!online) return { mode: prefs.offline_choice === 'wait' ? 'wait' : 'direct', ...prefs };
    return { mode: 'link', device: online.id, device_name: online.name || 'My computer', relay_url: online.relay_url, ...prefs };
}

async function open(db, { session_id: session, credential, node_id: device }, now = Date.now()) {
    if (!SESSION.test(session || '') || !TOKEN.test(credential || '') || !NODE.test(device || '')) throw fail(403, 'refused');
    const row = await db.prepare('SELECT * FROM link_egress_sessions WHERE session_id = ?').get(session);
    if (!row || row.ended || Number(row.expires_at) <= now || row.node_id !== device ||
        !crypto.timingSafeEqual(Buffer.from(row.credential_hash, 'hex'), Buffer.from(sha(credential), 'hex'))) throw fail(403, 'refused');
    const target = await node(db, device);
    // Never trust the ownership captured at registration: unpairing, transfers and opt-out take effect here.
    if (target.owner_kind !== 'user' || target.owner_subject !== row.owner_subject) throw fail(403, 'owner_mismatch');
    const prefs = await settings(db, row.owner_subject);
    if (!prefs.egress_via_link || prefs.monthly_bytes === 0) throw fail(403, 'disabled');
    return { session_id: session, node_id: device, expires_at: Number(row.expires_at), ...prefs };
}

function mount({ user, self, internal, pairing, requireAuth, now = () => Date.now() }) {
    if (user) {
        user.get('/egress', requireAuth, wrap(async (req, res) => {
            const owner = await ensureUserSubject(req.app.locals.db, req.user);
            if (!SUBJECT.test(owner || '')) throw fail(403, 'person_required');
            res.json({ ...await settings(req.app.locals.db, owner), explanation: EXPLANATION });
        }));
        user.put('/egress', requireAuth, express.json({ limit: '16kb' }), wrap(async (req, res) => {
            const db = req.app.locals.db;
            const owner = await ensureUserSubject(db, req.user);
            if (!SUBJECT.test(owner || '')) throw fail(403, 'person_required');
            const p = validateSettings(req.body);
            await db.prepare(`INSERT INTO link_egress_settings(owner_subject, egress_via_link, offline_choice, monthly_bytes, excluded_sites)
                VALUES (?, ?, ?, ?, ?::jsonb) ON CONFLICT(owner_subject) DO UPDATE SET
                egress_via_link = EXCLUDED.egress_via_link, offline_choice = EXCLUDED.offline_choice,
                monthly_bytes = EXCLUDED.monthly_bytes, excluded_sites = EXCLUDED.excluded_sites`)
                .run(owner, p.egress_via_link, p.offline_choice, p.monthly_bytes, JSON.stringify(p.excluded_sites));
            res.json(await settings(db, owner));
        }));
    }
    if (self) {
        self.get('/egress/identity', wrap(async (req, res) => {
            const n = await ownNode(req.app.locals.db, req);
            if (n.owner_kind !== 'user') throw fail(403, 'person_required');
            res.json({ node_id: n.id, owner: n.owner_subject, name: n.name });
        }));
        self.put('/egress/heartbeat', express.json({ limit: '2kb' }), wrap(async (req, res) => {
            const db = req.app.locals.db, n = await ownNode(db, req);
            if (n.owner_kind !== 'user') throw fail(403, 'person_required');
            const url = String(req.body?.relay_url || '');
            // A device cannot make a cloud host connect to an arbitrary URL or local address.
            if (!/^wss:\/\/[a-z0-9-]+\.openvibe\.link\/__ov_egress$/.test(url)) throw fail(422, 'invalid_relay');
            await db.prepare(`INSERT INTO link_egress_devices(node_id, relay_url, checked_at) VALUES (?, ?, ?)
                ON CONFLICT(node_id) DO UPDATE SET relay_url = EXCLUDED.relay_url, checked_at = EXCLUDED.checked_at`).run(n.id, url, now());
            res.json(await settings(db, n.owner_subject));
        }));
        // A cloud Node can read only the decision for a desk assigned to its own Bot machine id.
        self.get('/egress/desks/:desk', wrap(async (req, res) => {
            const db = req.app.locals.db, n = await ownNode(db, req);
            if (!DESK.test(req.params.desk)) throw fail(404, 'desk_unknown');
            const { config, privateKey } = req.app.locals;
            const bot = require('../registry/machines').createBotClient({ baseUrl: config.services.bot.internalUrl, privateKey, issuer: config.jwt.issuer });
            const machine = await cloudMachine(bot, n);
            const row = await db.prepare('SELECT * FROM link_egress_sessions WHERE machine = ? AND desk = ? AND ended = false AND expires_at > ?')
                .get(machine, req.params.desk, now());
            if (!row) throw fail(404, 'desk_unknown');
            const route = await selectRoute(db, row.owner_subject, now());
            const credential = crypto.randomBytes(32).toString('base64url');
            await db.prepare('UPDATE link_egress_sessions SET credential_hash = ?, node_id = ? WHERE session_id = ? AND ended = false')
                .run(sha(credential), route.device || null, row.session_id);
            res.json({ session_id: row.session_id, credential, ...route });
        }));
    }
    if (internal) {
        const guard = require('../identity/principals').guard('network.registry.read');
        const runOnly = (req, res, next) => req.principal?.sub === 'svc:run' ? next() : http.sendProblem(res, 403, 'egress.run_required');
        internal.put('/egress/sessions/:session', guard, runOnly, express.json({ limit: '4kb' }), wrap(async (req, res) => {
            const db = req.app.locals.db, b = req.body || {};
            if (!SESSION.test(req.params.session) || !SUBJECT.test(b.owner || '') || !MACHINE.test(b.machine || '') ||
                !DESK.test(b.desk || '') || !TOKEN.test(b.credential || '') || !Number.isSafeInteger(b.expires_at) ||
                b.expires_at <= now() || b.expires_at > now() + 86_400_000) throw fail(422, 'invalid_session');
            const route = await selectRoute(db, b.owner, now());
            const old = await db.prepare('SELECT owner_subject FROM link_egress_sessions WHERE session_id = ?').get(req.params.session);
            if (old && old.owner_subject !== b.owner) throw fail(403, 'owner_mismatch');
            await db.prepare(`INSERT INTO link_egress_sessions(session_id, owner_subject, machine, desk, node_id, credential_hash, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET machine = EXCLUDED.machine,
                desk = EXCLUDED.desk, node_id = EXCLUDED.node_id, credential_hash = EXCLUDED.credential_hash,
                expires_at = EXCLUDED.expires_at, ended = false`).run(req.params.session, b.owner, b.machine, b.desk,
                route.device || null, sha(b.credential), b.expires_at);
            res.json(route);
        }));
        internal.post('/egress/sessions/:session/renew', guard, runOnly, wrap(async (req, res) => {
            await req.app.locals.db.prepare('UPDATE link_egress_sessions SET expires_at = ? WHERE session_id = ? AND ended = false')
                .run(now() + 120_000, req.params.session);
            res.status(204).end();
        }));
        internal.delete('/egress/sessions/:session', guard, runOnly, wrap(async (req, res) => {
            await req.app.locals.db.prepare('UPDATE link_egress_sessions SET ended = true WHERE session_id = ?').run(req.params.session);
            res.status(204).end();
        }));
    }

}

function publicRouter() {
    const r = express.Router();
    r.post('/api/v1/link-egress/open', require('express-rate-limit')({ windowMs: 10_000, max: 3000 }),
        express.json({ limit: '2kb' }), wrap(async (req, res) => res.json(await open(req.app.locals.db, req.body || {}))));
    return r;
}

module.exports = { cloudMachine, publicRouter, mount, settings, validateSettings, selectRoute, open, EXPLANATION, DEFAULT_BYTES };
