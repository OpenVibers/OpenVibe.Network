'use strict';
const express = require('express');
const levels = require('../levels/store');
const follows = require('../identity/follows');
const { SITES } = require('../frame/sites');
const TTL_MS = 30_000;
const MAX_CACHE = 2000;
const FIELDS = ['display_name', 'avatar_url', 'live', 'level', 'streak', 'badges_count', 'followers', 'active_sites', 'channel_url'];
const defaults = () => Object.fromEntries(FIELDS.map(k => [k, k !== 'active_sites']));
const object = value => { try { return typeof value === 'string' ? JSON.parse(value) : (value || {}); } catch { return {}; } };

function createUserCards({ db, profiles, selfToken = () => null, questUrl = 'http://127.0.0.1:4980', liveUrl = 'http://127.0.0.1:3000', fetchImpl = (...args) => fetch(...args), now = Date.now }) {
    const cache = new Map();
    const pending = new Map();
    async function enabled() {
        const row = await db.prepare("SELECT value FROM site_settings WHERE key = 'user_card_enabled'").get();
        return row?.value === 'true';
    }
    async function json(base, path, token) {
        const response = await fetchImpl(String(base).replace(/\/+$/, '') + path, {
            headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            signal: AbortSignal.timeout(2000), redirect: 'error',
        });
        if (!response.ok) throw new Error('Card source unavailable');
        return response.json();
    }
    async function policy(user) {
        const row = await db.prepare(`SELECT u.card_visibility, u.history_paused, u.history_keep_private, u.history_keep_mature,
            l.leaderboard, p.show_status, p.state FROM users u LEFT JOIN person_levels l ON l.user_id = u.id
            LEFT JOIN person_presence p ON p.subject_id = u.subject_id WHERE u.id = ?`).get(user.id);
        const visible = { ...defaults(), ...object(row.card_visibility) };
        const places = object(user.public_page_places);
        if (!Number(user.profile_public)) for (const key of FIELDS.slice(2)) visible[key] = false;
        if (places.live === false) { visible.live = false; visible.channel_url = false; }
        if (row.show_status === 0 || row.show_status === '0' || row.state === 'invisible') visible.live = false;
        if (row.leaderboard === false) visible.level = false;
        if (Number(row.history_paused) || Number(row.history_keep_private) || Number(row.history_keep_mature)) visible.active_sites = false;
        return { visible, places };
    }
    async function build(user, rules) {
        const { visible, places } = rules;
        const out = { username: user.username, profile_url: `https://openvibe.network/@${encodeURIComponent(user.username)}` };
        if (visible.display_name) out.display_name = user.display_name || user.username;
        if (visible.avatar_url) out.avatar_url = `https://openvibe.network/avatar/${encodeURIComponent(user.username)}?s=160`;
        const tasks = [];
        const hasSubject = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(user.subject_id || '');
        if (visible.level) tasks.push(levels.total(db, user.id).then(value => { out.level = value.level; }));
        if (visible.followers && hasSubject) tasks.push(follows.count(db, 'user', user.subject_id).then(value => { out.followers = Number(value); }));
        if (visible.badges_count && hasSubject) tasks.push(json(questUrl, `/api/v1/profiles/${encodeURIComponent(user.subject_id)}/badges`, selfToken('openvibe.quest', ['quest.badge.read'])).then(value => {
            if (Array.isArray(value.badges)) out.badges_count = value.badges.length;
        }).catch(() => {}));
        if (visible.streak && hasSubject) tasks.push(json(questUrl, `/api/v1/profiles/${encodeURIComponent(user.subject_id)}/streak`, selfToken('openvibe.quest', ['quest.badge.read'])).then(value => {
            if (Number.isSafeInteger(value.streak) && value.streak >= 0) out.streak = value.streak;
        }).catch(() => {}));
        if (visible.live || visible.channel_url) tasks.push(json(liveUrl, `/api/streams/channel/${encodeURIComponent(user.username)}/live`).then(value => {
            if (!value.channel || String(value.channel.username).toLowerCase() !== user.username.toLowerCase() || !Array.isArray(value.streams)) return;
            const url = `https://openvibe.live/@${encodeURIComponent(value.channel.username)}`;
            if (visible.channel_url) out.channel_url = url;
            if (visible.live) out.live = { now: value.streams.length > 0, ...(value.streams.length ? { site: 'live', url } : {}) };
        }).catch(() => {}));
        if (visible.active_sites) tasks.push(db.prepare(`SELECT DISTINCT service FROM user_history
            WHERE user_id = ? AND updated_at >= (now() - interval '7 days')::text`).all(user.id).then(rows => {
            const services = new Set(rows.map(r => r.service));
            out.active_sites = SITES.filter(s => (services.has(s.id) || services.has(s.service)) && s.host
                && places[s.id] !== false && !(places.media === false && ['media-hub', 'pics', 'video'].includes(s.id)))
                .map(s => ({ id: s.id, name: s.name, url: `https://${s.host}` }));
        }));
        await Promise.all(tasks);
        return out;
    }
    async function read(username) {
        const found = await profiles.find(username);
        if (!found) return null;
        if (found.moved) return { moved: found.moved };
        const user = found.user;
        // Recheck privacy and account eligibility on every read, including cache hits. A privacy change
        // changes the key immediately; an in-flight old build cannot overwrite the new policy's value.
        const rules = await policy(user);
        const key = JSON.stringify([user.id, user.subject_id, user.username, user.display_name, rules]);
        const hit = cache.get(key);
        if (hit && now() - hit.at < TTL_MS) return hit.value;
        if (pending.has(key)) return pending.get(key);
        const task = build(user, rules).then(value => {
            cache.set(key, { at: now(), value });
            if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
            return value;
        }).finally(() => pending.delete(key));
        pending.set(key, task);
        return task;
    }
    const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
    const api = handle(async (req, res) => {
        res.set('Cache-Control', 'no-store'); // Never let a browser/CDN outlive a privacy change.
        if (!await enabled()) return res.status(503).json({ error: 'user_card.disabled' });
        const value = await read(req.params.username);
        if (!value) return res.status(404).json({ error: 'user_card.not_found' });
        if (value.moved) return res.redirect(307, `/api/v1/people/${encodeURIComponent(value.moved)}/card`);
        return res.json(value);
    });
    function settings(requireAuth) {
        const router = express.Router();
        router.use(requireAuth, (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
        router.get('/', handle(async (req, res) => {
            const row = await db.prepare('SELECT card_visibility FROM users WHERE id = ?').get(req.user.id);
            res.json({ ...defaults(), ...object(row.card_visibility) });
        }));
        router.put('/', handle(async (req, res) => {
            if (!req.body || Array.isArray(req.body) || !Object.keys(req.body).length || Object.entries(req.body).some(([k, v]) => !FIELDS.includes(k) || typeof v !== 'boolean')) {
                return res.status(400).json({ error: 'user_card.invalid_visibility' });
            }
            await db.prepare('UPDATE users SET card_visibility = card_visibility || ?::jsonb WHERE id = ?').run(JSON.stringify(req.body), req.user.id);
            const row = await db.prepare('SELECT card_visibility FROM users WHERE id = ?').get(req.user.id);
            res.json({ ...defaults(), ...object(row.card_visibility) });
        }));
        return router;
    }
    return { api, settings, read };
}
module.exports = { createUserCards, TTL_MS, MAX_CACHE };
