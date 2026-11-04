'use strict';
// Sign in on your phone (owner, 2026-11-04; NETWORK_QR_SIGNIN): the full flow, the one-session rule under a
// race, every refusal (409 second scan, 404 unknown/expired/guessed, 403 another session, three wrong codes),
// the ov_qr binding, the audit's contents, the new-sign-in notice, the rate limits and the flag-off 404.
//   node test/qr-signin.test.js
const assert = require('assert');
const jwt = require('jsonwebtoken');
const { bootServer } = require('./helpers/boot-server');
const qr = require('../server/auth/qr-signin');
const { signToken } = require('../server/auth/routes');
const subjects = require('../server/identity/subjects');
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// The same-origin rule the router applies to every POST (CORS's first-party list is wider than one origin).
const conf = { networkUrl: 'https://openvibe.network', baseUrl: 'https://openvibe.network', loginUrl: 'https://openvibe.network' };
assert.strictEqual(qr.sameOrigin({ headers: {} }, conf), true, 'no Origin: a non-browser request');
assert.strictEqual(qr.sameOrigin({ headers: { origin: 'https://openvibe.network' } }, conf), true);
assert.strictEqual(qr.sameOrigin({ headers: { origin: 'https://openvibe.live' } }, conf), false, 'another first-party site is not this origin');
assert.strictEqual(qr.sameOrigin({ headers: { origin: 'https://openvibe.network.evil.example' } }, conf), false);
assert.strictEqual(qr.sameOrigin({ headers: { origin: 'http://openvibe.network' } }, conf), false, 'scheme matters');
assert.strictEqual(qr.deviceSummary(IPHONE_UA), 'iPhone · Safari');
assert.strictEqual(qr.deviceSummary('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'), 'Android · Chrome');
assert.match(qr.newUlid(), /^[0-9A-HJKMNP-TV-Z]{26}$/);

function setCookies(res) {
    if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
    const one = res.headers.get('set-cookie');
    return one ? [one] : [];
}
function cookieOf(cookies, name) {
    for (const raw of cookies) {
        const m = String(raw).match(new RegExp(`^${name}=([^;]*)`));
        if (m) return decodeURIComponent(m[1]);
    }
    return null;
}

(async () => {
    const srv = await bootServer({ env: { NETWORK_QR_SIGNIN: '1' } });
    const db = srv.app.locals.db;
    const base = srv.base;

    const api = async (method, path, { token, cookie, body, headers = {} } = {}) => {
        const h = { origin: 'https://openvibe.network', 'x-forwarded-for': '203.0.113.9', ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        if (cookie) h.cookie = cookie;
        if (body !== undefined) h['content-type'] = 'application/json';
        const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        return { status: res.status, text, json, setCookies: setCookies(res) };
    };

    const suffix = Math.random().toString(36).slice(2, 9);
    const username = `qr${suffix}`;
    const config = srv.app.locals.config;
    const privateKey = srv.app.locals.privateKey;
    const mkUser = async (name) => {
        const id = (await db.prepare('INSERT INTO users (username, email, password_hash, display_name, subject_id) VALUES (?, ?, ?, ?, ?) RETURNING id')
            .run(name, `${name}@example.com`, 'x', name, subjects.newUserSubjectId())).lastInsertRowid;
        const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        return { user: row, token: signToken(row, privateKey, config) };
    };
    const register = await mkUser(username);
    const user = register.user;
    const desktop = register.token;
    // Another session of the same person: a different jti, so it must not approve the first one's transfer.
    const secondSession = signToken(user, privateKey, config);
    const refreshed = await api('POST', '/api/auth/refresh', { token: desktop, body: {} });
    assert.strictEqual(refreshed.status, 200, refreshed.text);
    assert.strictEqual(jwt.decode(refreshed.json.token).jti, jwt.decode(desktop).jti, 'a sliding renewal keeps the session jti');
    const liveUser = await mkUser(`ql${suffix}`);
    const limitUser = await mkUser(`qh${suffix}`);

    const start = async (token = desktop) => {
        const r = await api('POST', '/auth/qr/start', { token, body: {} });
        if (r.status !== 201) return r;
        const split = new URL(r.json.url).hash.slice(1).split('.');
        assert.strictEqual(split[0], r.json.id, 'the URL names the transfer');
        assert.match(split[1], /^[0-9a-f]{32}$/, 'a 128-bit secret in the fragment');
        return { ...r, id: r.json.id, secret: split[1] };
    };
    const scan = async (id, secret) => api('POST', '/auth/qr/scan', {
        body: { id, secret }, headers: { 'user-agent': IPHONE_UA },
    });
    const phoneCookie = (scanResponse) => cookieOf(scanResponse.setCookies, 'ov_qr');
    const status = (cookie) => api('GET', '/auth/qr/status', { cookie: cookie ? `ov_qr=${cookie}` : undefined });
    const countSessions = async () => Number((await db.prepare('SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ?').get(user.id)).n);

    // ── Happy path: scan, poll, approve, phone completes once ──
    let started = await start();
    assert.strictEqual(started.status, 201, started.text);
    assert.match(started.json.qr_svg, /^<svg\b/, 'Network renders the SVG itself');
    assert.ok(started.json.url.endsWith(`/q#${started.id}.${started.secret}`), 'the secret is only in the fragment');
    assert.ok(Date.parse(started.json.expires_at) - Date.now() <= 120000, '120 s');
    assert.ok(Date.parse(started.json.expires_at) - Date.now() > 110000);

    let scanned = await scan(started.id, started.secret);
    assert.strictEqual(scanned.status, 200, scanned.text);
    assert.match(String(scanned.json.code), /^[1-9][0-9]$/, 'two digits, 10-99');
    assert.strictEqual(scanned.json.user_hint.display_name, user.display_name || user.username);
    const ovQr = phoneCookie(scanned);
    assert.ok(ovQr && /^[0-9a-f]{32}$/.test(ovQr), 'a 128-bit ov_qr nonce');
    const qrSet = scanned.setCookies.find((c) => c.startsWith('ov_qr='));
    assert.match(qrSet, /HttpOnly/i);
    assert.match(qrSet, /Secure/i);
    assert.match(qrSet, /SameSite=Lax/i);
    assert.match(qrSet, /Path=\/auth\/qr/i);
    assert.match(qrSet, /Max-Age=300/i);

    let polled = await api('GET', `/auth/qr/${started.id}`, { token: desktop });
    assert.strictEqual(polled.status, 200, polled.text);
    assert.strictEqual(polled.json.state, 'scanned');
    assert.strictEqual(polled.json.device, 'iPhone · Safari');
    assert.ok(!('code' in polled.json), 'the desktop never receives the code');

    let approved = await api('POST', `/auth/qr/${started.id}/approve`, { token: desktop, body: { code: scanned.json.code } });
    assert.strictEqual(approved.status, 200, approved.text);
    assert.strictEqual(approved.json.state, 'approved');

    const before = await countSessions();
    const completed = await status(ovQr);
    assert.strictEqual(completed.status, 200, completed.text);
    assert.strictEqual(completed.json.state, 'used');
    assert.strictEqual(completed.json.signed_in, true);
    assert.strictEqual(completed.json.user.id, user.id);
    assert.strictEqual(await countSessions(), before + 1, 'exactly one device session');
    const sessionToken = cookieOf(completed.setCookies, 'ov_token');
    assert.ok(sessionToken, 'the ordinary session cookies are set');
    assert.ok(completed.setCookies.some((c) => c.startsWith('ov_qr=') && /Max-Age=0/i), 'ov_qr is cleared');
    const me = await api('GET', '/api/auth/me', { token: sessionToken });
    assert.strictEqual(me.status, 200, me.text);
    assert.strictEqual(me.json.user.id, user.id);
    const device = await db.prepare("SELECT device_name, ip FROM user_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(user.id);
    assert.strictEqual(device.device_name, 'iPhone · Safari');
    assert.strictEqual(device.ip, null, 'the phone session records no IP');

    const again = await status(ovQr);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.json.state, 'used');
    assert.strictEqual(again.json.signed_in, false);
    assert.strictEqual(await countSessions(), before + 1, 'still exactly one session');

    // ── A second scan is refused with 409 ──
    let secondStart = await start();
    let secondScan = await scan(secondStart.id, secondStart.secret);
    assert.strictEqual(secondScan.status, 200, secondScan.text);
    const againScan = await scan(secondStart.id, secondStart.secret);
    assert.strictEqual(againScan.status, 409);
    assert.strictEqual(againScan.json.error, 'already used on another device');
    await api('POST', `/auth/qr/${secondStart.id}/deny`, { token: desktop, body: {} });

    // ── A wrong code three times denies the transfer ──
    let wrongStart = await start();
    let wrongScan = await scan(wrongStart.id, wrongStart.secret);
    const wrong = wrongScan.json.code === '99' ? '98' : '99';
    const tries = [];
    for (let i = 0; i < 3; i++) tries.push(await api('POST', `/auth/qr/${wrongStart.id}/approve`, { token: desktop, body: { code: wrong } }));
    assert.deepStrictEqual(tries.map((r) => r.status), [400, 400, 403]);
    assert.strictEqual(tries[0].json.error, 'code_mismatch');
    assert.strictEqual(tries[0].json.attempts_left, 2);
    assert.strictEqual(tries[2].json.error, 'denied');
    const deniedPoll = await api('GET', `/auth/qr/${wrongStart.id}`, { token: desktop });
    assert.strictEqual(deniedPoll.json.state, 'denied');
    assert.strictEqual((await status(phoneCookie(wrongScan))).json.state, 'denied');

    // ── Guessed id or secret and an expired transfer are the same 404 ──
    const guessId = await api('POST', '/auth/qr/scan', { body: { id: '01J00000000000000000000000', secret: 'a'.repeat(32) } });
    assert.strictEqual(guessId.status, 404);
    const guessSecret = await scan(secondStart.id, 'b'.repeat(32));
    assert.strictEqual(guessSecret.status, 404);
    assert.deepStrictEqual(guessId.json, guessSecret.json);

    let expired = await start();
    await db.prepare('UPDATE qr_signin_transfers SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), expired.id);
    assert.strictEqual((await scan(expired.id, expired.secret)).status, 404, 'an expired transfer is 404, like a guess');
    assert.strictEqual((await api('GET', `/auth/qr/${expired.id}`, { token: desktop })).status, 404);
    const expiryStart = await start();
    const expiryScanned = await scan(expiryStart.id, expiryStart.secret);
    assert.strictEqual(expiryScanned.status, 200);
    await db.prepare('UPDATE qr_signin_transfers SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), expiryStart.id);
    assert.strictEqual((await status(phoneCookie(expiryScanned))).status, 404, 'the phone learns an expired transfer as 404 too');
    await qr.sweep(db, { now: Date.now() });
    assert.ok(!(await db.prepare('SELECT 1 AS ok FROM qr_signin_transfers WHERE id = ?').get(expired.id)), 'the jobs sweep deletes expired transfers');

    // ── The phone cannot finish without its ov_qr cookie ──
    let noCookieStart = await start();
    let noCookieScan = await scan(noCookieStart.id, noCookieStart.secret);
    await api('POST', `/auth/qr/${noCookieStart.id}/approve`, { token: desktop, body: { code: noCookieScan.json.code } });
    assert.strictEqual((await status(null)).status, 404);
    assert.strictEqual((await status('c'.repeat(32))).status, 404);
    await api('POST', `/auth/qr/${noCookieStart.id}/deny`, { token: desktop, body: {} });

    // ── Approval needs the creating session, not just the person ──
    let sessionStart = await start();
    let sessionScan = await scan(sessionStart.id, sessionStart.secret);
    const other = await api('POST', `/auth/qr/${sessionStart.id}/approve`, { token: secondSession, body: { code: sessionScan.json.code } });
    assert.strictEqual(other.status, 403, 'another session of the same user cannot approve');
    assert.strictEqual((await api('GET', `/auth/qr/${sessionStart.id}`, { token: secondSession })).status, 403);
    assert.strictEqual((await api('POST', `/auth/qr/${sessionStart.id}/approve`, { token: desktop, body: { code: sessionScan.json.code } })).status, 200);
    assert.strictEqual((await status(phoneCookie(sessionScan))).json.signed_in, true);

    // ── A renewed desktop token is still the creating session (jti survives renewal) ──
    let renewStart = await start();
    let renewScan = await scan(renewStart.id, renewStart.secret);
    assert.strictEqual((await api('POST', `/auth/qr/${renewStart.id}/approve`, { token: refreshed.json.token, body: { code: renewScan.json.code } })).status, 200);
    assert.strictEqual((await status(phoneCookie(renewScan))).json.signed_in, true);

    // ── Racing polls create exactly one session ──
    let raceStart = await start();
    let raceScan = await scan(raceStart.id, raceStart.secret);
    await api('POST', `/auth/qr/${raceStart.id}/approve`, { token: desktop, body: { code: raceScan.json.code } });
    const raceBefore = await countSessions();
    const raceCookie = phoneCookie(raceScan);
    const raced = await Promise.all([status(raceCookie), status(raceCookie)]);
    assert.strictEqual(raced.filter((r) => r.json && r.json.signed_in === true).length, 1, 'one poll signs in');
    assert.strictEqual(raced.filter((r) => cookieOf(r.setCookies, 'ov_token')).length, 1, 'one response sets the session');
    assert.strictEqual(await countSessions(), raceBefore + 1, 'exactly one session from the race');

    // ── The notice names the device and the QR sign-in ──
    const notice = await db.prepare("SELECT title, message FROM notifications WHERE user_id = ? AND service = 'network' ORDER BY created_at DESC, id DESC LIMIT 5").all(user.id);
    const signInNotice = notice.find((n) => n.title === 'New sign-in');
    assert.ok(signInNotice, 'the person gets the new-sign-in notice');
    assert.ok(signInNotice.message.includes('iPhone · Safari') && signInNotice.message.includes('by QR from your computer'));

    // ── The audit has the user, transfer and outcome; never the secret, code or IP ──
    const audits = await db.prepare("SELECT action, details, ip FROM audit_log WHERE user_id = ? AND action LIKE 'qr_signin%' ORDER BY id").all(user.id);
    const actions = new Set(audits.map((a) => a.action));
    for (const action of ['qr_signin_started', 'qr_signin_scanned', 'qr_signin_approved', 'qr_signin_used', 'qr_signin_denied']) assert.ok(actions.has(action), action);
    for (const row of audits) {
        assert.strictEqual(row.ip, null, 'the audit stores no IP');
        const details = JSON.parse(row.details);
        assert.deepStrictEqual(Object.keys(details).sort(), ['device', 'outcome', 'transfer_id'], 'only the summary fields');
        assert.notStrictEqual(details.transfer_id, undefined);
        assert.notStrictEqual(details.transfer_id, started.secret);
        assert.notStrictEqual(String(details.transfer_id), String(scanned.json.code));
        assert.ok(!JSON.stringify(details).includes('203.0.113.9'), 'no IP');
    }

    // ── At most 3 live transfers ──
    const live = [];
    for (let i = 0; i < 3; i++) live.push(await start(liveUser.token));
    assert.ok(live.every((r) => r.status === 201), live.map((r) => r.status).join(','));
    const fourth = await start(liveUser.token);
    assert.strictEqual(fourth.status, 429);
    assert.strictEqual(fourth.json.error, 'too_many_codes');
    for (const r of live) await api('POST', `/auth/qr/${r.id}/deny`, { token: liveUser.token, body: {} });

    // ── 10 starts per person per hour ──
    for (let i = 0; i < 10; i++) {
        const r = await start(limitUser.token);
        assert.strictEqual(r.status, 201, `start ${i + 1} of the hourly budget`);
        await api('POST', `/auth/qr/${r.id}/deny`, { token: limitUser.token, body: {} });
    }
    assert.strictEqual((await start(limitUser.token)).status, 429, 'the 11th start in an hour is refused');

    // ── A foreign Origin cannot start a transfer ──
    const foreign = await api('POST', '/auth/qr/start', { token: desktop, body: {}, headers: { origin: 'https://phish.example' } });
    assert.strictEqual(foreign.status, 403);

    // ── The phone page is served only with the flag on ──
    const page = await api('GET', '/q');
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.includes('Type this number on your computer'));

    // ── Repeated guesses spend the per-address auth limiter's budget and are refused ──
    const guesses = [];
    for (let i = 0; i < 40; i++) {
        guesses.push((await api('POST', '/auth/qr/scan', { body: { id: '01J00000000000000000000000', secret: 'd'.repeat(32) } })).status);
    }
    assert.ok(guesses.includes(429), 'repeated 404s from one address hit the auth limiter');

    await srv.stop();

    // ── Off by default: the same routes and /q are 404 ──
    const off = await bootServer({ child: true });
    try {
        const r = await fetch(`${off.base}/auth/qr/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.strictEqual(r.status, 404, 'the start route is not mounted when the flag is off');
        const q = await fetch(`${off.base}/q`);
        assert.strictEqual(q.status, 404, '/q is not served when the flag is off');
    } finally {
        await off.stop();
    }

    console.log('qr sign-in: all checks passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
