'use strict';
const express = require('express');
const { validate } = require('openvibe-contracts');

const CONTRACT = 'network.home-screen@1';
const empty = () => ({ home: [], folders: [], updated_at: null });
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createHomeScreen({ db, now = () => Date.now() }) {
    async function read(userId) {
        const row = await db.prepare('SELECT home_screen FROM user_preferences WHERE user_id = ?').get(userId);
        if (!row || !row.home_screen) return empty();
        let value;
        try { value = typeof row.home_screen === 'string' ? JSON.parse(row.home_screen) : row.home_screen; } catch { return empty(); }
        return validate(CONTRACT, value).valid ? value : empty();
    }

    async function write(userId, body) {
        if (!object(body) || Object.keys(body).some((key) => !['home', 'folders', 'updated_at'].includes(key))) {
            throw Object.assign(new Error('home and folders are required; no other fields are accepted'), { status: 400 });
        }
        const value = { home: body.home, folders: body.folders, updated_at: new Date(now()).toISOString() };
        const result = validate(CONTRACT, value);
        if (!result.valid) throw Object.assign(new Error(JSON.stringify(result.errors)), { status: 400 });
        const ids = new Set(value.folders.map((folder) => folder.id));
        if (ids.size !== value.folders.length || value.home.some((id) => id.startsWith('folder:') && !ids.has(id.slice(7)))) {
            throw Object.assign(new Error('folder ids must be unique and every Home folder must exist'), { status: 400 });
        }
        await db.prepare(`INSERT INTO user_preferences (user_id, home_screen, updated_at) VALUES (?, ?, ov_now())
                          ON CONFLICT (user_id) DO UPDATE SET home_screen = excluded.home_screen, updated_at = ov_now()`)
            .run(userId, JSON.stringify(value));
        return value;
    }
    return { read, write };
}

function router({ homeScreen, requireAuth }) {
    const r = express.Router();
    r.use((req, res, next) => {
        res.set('Cache-Control', 'private, no-store');
        if (!/^Bearer \S+$/.test(String(req.headers.authorization || ''))) return res.status(401).json({ error: 'home-screen.bearer_required' });
        next();
    });
    r.get('/', requireAuth, async (req, res) => {
        try { res.json(await homeScreen.read(req.user.id)); }
        catch (err) { console.error('[HomeScreen] read:', err); res.status(500).json({ error: 'home-screen.error' }); }
    });
    r.put('/', requireAuth, express.json({ limit: '8kb' }), async (req, res) => {
        try { res.json(await homeScreen.write(req.user.id, req.body)); }
        catch (err) {
            if (err.status === 400) return res.status(400).json({ error: 'home-screen.invalid', detail: err.message });
            console.error('[HomeScreen] write:', err); res.status(500).json({ error: 'home-screen.error' });
        }
    });
    return r;
}

module.exports = { createHomeScreen, router, CONTRACT };
