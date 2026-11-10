'use strict';

const express = require('express');
const crypto = require('crypto');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TTL_MINUTES = 60;
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const clean = (email) => String(email || '').trim().toLowerCase();
const { isFreshSignIn } = require('./reauth');

function needsFreshSignIn(req, res) {
    if (isFreshSignIn(req.tokenClaims)) return false;
    return res.status(401).json({ ok: false, error: 'auth.sign_in_again', detail: 'Sign in again within the last 10 minutes to change email addresses.', reauth_url: '/login?reauth=1&return=%2Fmy%23emails' });
}

async function selectedForClient(db, userId, clientId) {
    return db.prepare(`SELECT ae.id, ae.email, ae.verified_at FROM account_email_grants g
        JOIN account_emails ae ON ae.id = g.account_email_id AND ae.user_id = g.user_id
        WHERE g.user_id = ? AND g.client_id = ? AND ae.verified = 1`).get(userId, clientId);
}

function meRouter({ requireAuth }) {
    const router = express.Router();
    router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store').set('Vary', 'Authorization'); next(); });
    const ownerOnly = (req, res, next) => {
        const client = req.tokenClaims?.client_id;
        if (client && client !== 'my') return res.status(403).json({ ok: false, error: 'Manage account email addresses on openvibe.my.' });
        next();
    };
    const sharedRead = (req, res, next) => {
        const client = req.tokenClaims?.client_id;
        const scopes = String(req.tokenClaims?.scope || '').split(/\s+/);
        if (client && client !== 'my' && !scopes.includes('identity.emails.read')) return res.status(403).json({ ok: false, error: 'This app has not been granted identity.emails.read.' });
        req.sharedEmailRead = !!client && client !== 'my';
        next();
    };
    const list = async (db, userId) => {
        const user = await db.prepare('SELECT email, email_verified, email_verified_at FROM users WHERE id = ?').get(userId);
        if (user?.email) {
            const primary = await db.prepare('SELECT id, email FROM account_emails WHERE user_id = ? AND is_primary = 1').get(userId);
            if (!primary) await db.prepare('INSERT INTO account_emails (id, user_id, email, verified, verified_at, is_primary) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING')
                .run(`legacy-${userId}`, userId, user.email, user.email_verified || 0, user.email_verified_at || null);
            else if (clean(primary.email) !== clean(user.email)) await db.prepare('UPDATE account_emails SET email = ?, verified = ?, verified_at = ? WHERE id = ? AND user_id = ?')
                .run(user.email, user.email_verified || 0, user.email_verified_at || null, primary.id, userId);
        }
        return (await db.prepare('SELECT id, email, verified, verified_at, is_primary, created_at FROM account_emails WHERE user_id = ? ORDER BY is_primary DESC, created_at, id').all(userId)).map((row) => ({
            id: row.id, email: row.email, verified: !!row.verified, verified_at: row.verified_at || null, primary: !!row.is_primary, created_at: row.created_at,
        }));
    };

    router.get('/', requireAuth, sharedRead, async (req, res) => {
        const emails = await list(req.app.locals.db, req.user.id);
        if (!req.sharedEmailRead) return res.json({ emails });
        const grant = await req.app.locals.db.prepare(`SELECT ae.id, ae.email, ae.verified, ae.verified_at, ae.created_at, ae.is_primary
            FROM account_email_grants g JOIN account_emails ae ON ae.id = g.account_email_id
            WHERE g.user_id = ? AND g.client_id = ? AND ae.user_id = ? AND ae.verified = 1`).get(req.user.id, req.tokenClaims.client_id, req.user.id);
        res.json({ emails: grant ? [{ id: grant.id, email: grant.email, verified: true, verified_at: grant.verified_at || null, primary: !!grant.is_primary, created_at: grant.created_at }] : [] });
    });

    router.post('/', requireAuth, ownerOnly, async (req, res) => {
        const db = req.app.locals.db;
        const email = clean(req.body?.email);
        if (email.length > 254 || !EMAIL.test(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
        await list(db, req.user.id);
        const id = crypto.randomUUID();
        try {
            const result = await db.tx(async (t) => {
                await t.prepare('SELECT id FROM users WHERE id = ? FOR UPDATE').get(req.user.id);
                const total = await t.prepare('SELECT COUNT(*) AS c FROM account_emails WHERE user_id = ?').get(req.user.id);
                if ((total?.c || 0) >= 11) return 'total';
                const pending = await t.prepare('SELECT COUNT(*) AS c FROM account_emails WHERE user_id = ? AND verified = 0').get(req.user.id);
                if ((pending?.c || 0) >= 5) return 'pending';
                const own = await t.prepare('SELECT id FROM account_emails WHERE user_id = ? AND LOWER(email) = LOWER(?)').get(req.user.id, email);
                if (own) return 'duplicate';
                await t.prepare('INSERT INTO account_emails (id, user_id, email) VALUES (?, ?, ?)').run(id, req.user.id, email);
                return 'added';
            });
            if (result === 'total') return res.status(400).json({ ok: false, error: 'You can keep up to 11 email addresses on your account.' });
            if (result === 'pending') return res.status(400).json({ ok: false, error: 'Verify or remove a pending address before adding another.' });
            if (result === 'duplicate') return res.status(202).json({ ok: true, message: 'If this address can be added, a verification email will arrive shortly.' });
        } catch (err) {
            if (err.code === '23505' || /unique/i.test(err.message || '')) return res.status(202).json({ ok: true, message: 'If this address can be added, a verification email will arrive shortly.' });
            throw err;
        }
        await db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(req.user.id, 'email_address_added', JSON.stringify({ email }));
        await issue(req, { id, email, user_id: req.user.id });
        res.status(202).json({ ok: true, message: 'If this address can be added, a verification email will arrive shortly.' });
    });

    router.post('/:id/verify', requireAuth, ownerOnly, async (req, res) => {
        const row = await req.app.locals.db.prepare('SELECT id, user_id, email, verified FROM account_emails WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
        if (row && !row.verified) await issue(req, row);
        res.status(202).json({ ok: true, message: 'If this address can be verified, a verification email will arrive shortly.' });
    });

    router.delete('/:id', requireAuth, ownerOnly, async (req, res) => {
        if (needsFreshSignIn(req, res)) return;
        const db = req.app.locals.db;
        const row = await db.prepare('SELECT * FROM account_emails WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
        if (!row) return res.status(404).json({ ok: false, error: 'Email address not found.' });
        if (row.is_primary) return res.status(409).json({ ok: false, error: 'Choose another verified address as primary before removing this one.' });
        await db.prepare('DELETE FROM account_emails WHERE id = ? AND user_id = ?').run(row.id, req.user.id);
        await db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(req.user.id, 'email_address_removed', JSON.stringify({ email: row.email }));
        res.json({ ok: true, emails: await list(db, req.user.id) });
    });

    router.post('/:id/primary', requireAuth, ownerOnly, async (req, res) => {
        if (needsFreshSignIn(req, res)) return;
        const db = req.app.locals.db;
        const next = await db.prepare('SELECT * FROM account_emails WHERE id = ? AND user_id = ? AND verified = 1').get(req.params.id, req.user.id);
        if (!next) return res.status(404).json({ ok: false, error: 'A verified email address was not found.' });
        const verifiedAt = next.verified_at ? new Date(String(next.verified_at).replace(' ', 'T') + (String(next.verified_at).includes('Z') ? '' : 'Z')).getTime() : 0;
        if (!verifiedAt || Date.now() - verifiedAt > 90 * 24 * 60 * 60 * 1000) {
            await db.prepare('UPDATE account_emails SET verified = 0, verified_at = NULL WHERE id = ? AND user_id = ?').run(next.id, req.user.id);
            await issue(req, next);
            return res.status(202).json({ ok: true, message: 'Verify this address again before making it primary.' });
        }
        const current = await db.prepare('SELECT * FROM account_emails WHERE user_id = ? AND is_primary = 1').get(req.user.id);
        if (current?.id === next.id) return res.json({ ok: true, emails: await list(db, req.user.id) });
        await db.tx(async (t) => {
            await t.prepare('UPDATE account_emails SET is_primary = 0 WHERE user_id = ?').run(req.user.id);
            await t.prepare('UPDATE account_emails SET is_primary = 1 WHERE id = ? AND user_id = ?').run(next.id, req.user.id);
            await t.prepare('UPDATE users SET email = ?, email_verified = 1, email_verified_at = ?, email_bounced_at = NULL, email_bounce_reason = NULL WHERE id = ?').run(next.email, next.verified_at || new Date().toISOString(), req.user.id);
            await t.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)').run(req.user.id, 'primary_email_changed', JSON.stringify({ from: current?.email || null, to: next.email }));
        });
        if (current?.email) {
            try { await req.app.locals.notificationService?.create({ user_id: req.user.id, type: 'ACCOUNT_EMAIL_CHANGED', title: 'Primary email changed', message: `Your primary email is now ${next.email}.`, service: 'network', url: 'https://openvibe.my/' }); } catch { /* best effort */ }
            try { await req.app.locals.emailService?.sendAccountSecurityNotice?.({ to: current.email, username: req.user.display_name || req.user.username, message: `Your account's primary email address changed to ${next.email}.` }); } catch { /* best effort */ }
        }
        res.json({ ok: true, emails: await list(db, req.user.id) });
    });
    return router;
}

/** A service with identity.emails.read can learn only whether one subject owns one verified address. */
function verifiedCheckRouter(principals, { capabilityAvailable = null } = {}) {
    const router = express.Router();
    router.use(require('openvibe-contracts').http.middleware());
    router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store').set('Vary', 'Authorization'); next(); });
    const { capabilities } = require('openvibe-contracts');
    const capability = ['identity', 'emails', 'read'].join('.');
    const supported = capabilityAvailable === null ? !!capabilities.get(capability) : !!capabilityAvailable;
    const serviceGuard = supported ? principals.guard(capability) : (_req, res) => res.status(503).json({ error: 'The email check capability is not available in this Network release.' });
    router.post('/', serviceGuard, async (req, res) => {
        const subject = String(req.body?.subject || '');
        const email = clean(req.body?.email);
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject) || email.length > 254 || !EMAIL.test(email)) {
            return res.status(200).json({ verified: false });
        }
        const user = await req.app.locals.db.prepare('SELECT id FROM users WHERE subject_id = ?').get(subject);
        const verified = user ? await req.app.locals.db.prepare('SELECT 1 AS yes FROM account_emails WHERE user_id = ? AND verified = 1 AND LOWER(email) = LOWER(?)').get(user.id, email) : null;
        res.json({ verified: !!verified });
    });
    return router;
}

async function issue(req, row) {
    const db = req.app.locals.db;
    const service = req.app.locals.emailService;
    const recent = await db.prepare("SELECT COUNT(*) AS c FROM email_verification_tokens WHERE user_id = ? AND created_at > datetime('now','-3 minutes')").get(row.user_id);
    const today = await db.prepare("SELECT COUNT(*) AS c FROM email_verification_tokens WHERE user_id = ? AND created_at > datetime('now','-1 day')").get(row.user_id);
    const perAddress = await db.prepare("SELECT COUNT(*) AS c FROM email_verification_tokens WHERE LOWER(email) = LOWER(?) AND created_at > datetime('now','-1 day')").get(row.email);
    if (!service?.isEnabled || recent?.c || (today?.c || 0) >= 6 || (perAddress?.c || 0) >= 5) return false;
    const token = crypto.randomBytes(32).toString('base64url');
    await db.prepare(`INSERT INTO email_verification_tokens (token_hash, user_id, email, expires_at, account_email_id) VALUES (?, ?, ?, datetime('now', '+${TTL_MINUTES} minutes'), ?)`)
        .run(hash(token), row.user_id, row.email, row.id);
    const user = await db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(row.user_id);
    return service.sendVerificationEmail({ to: row.email, username: user?.display_name || user?.username, verifyUrl: `https://openvibe.network/verify-email?token=${encodeURIComponent(token)}`, expiresMinutes: TTL_MINUTES });
}

async function consume(db, row) {
    if (!row.account_email_id) return null;
    const address = await db.prepare('SELECT * FROM account_emails WHERE id = ? AND user_id = ? AND LOWER(email) = LOWER(?)').get(row.account_email_id, row.user_id, row.email);
    if (!address) return { ok: false, error: 'Your email address changed since this link was sent — request a new one.' };
    let claimed;
    try {
        claimed = await db.tx(async (t) => {
            const count = (await t.prepare('UPDATE email_verification_tokens SET used_at = ov_now() WHERE token_hash = ? AND used_at IS NULL').run(row.token_hash)).changes;
            if (!count) return false;
            const claimedByOther = await t.prepare('SELECT id FROM account_emails WHERE LOWER(email) = LOWER(?) AND verified = 1 AND user_id <> ?').get(address.email, address.user_id);
            if (claimedByOther) {
                await t.prepare('DELETE FROM account_emails WHERE id = ? AND user_id = ? AND verified = 0').run(address.id, address.user_id);
                return 'claimed';
            }
            await t.prepare('UPDATE account_emails SET verified = 1, verified_at = ov_now() WHERE id = ? AND user_id = ?').run(address.id, address.user_id);
            if (address.is_primary) await t.prepare('UPDATE users SET email_verified = 1, email_verified_at = ov_now(), email_bounced_at = NULL, email_bounce_reason = NULL WHERE id = ?').run(address.user_id);
            return true;
        });
    } catch (err) {
        if (err.code !== '23505' || !String(err.constraint || err.message || '').includes('account_emails_verified_email_unique')) throw err;
        await db.tx(async (t) => {
            await t.prepare('UPDATE email_verification_tokens SET used_at = ov_now() WHERE token_hash = ? AND used_at IS NULL').run(row.token_hash);
            await t.prepare('DELETE FROM account_emails WHERE id = ? AND user_id = ? AND verified = 0').run(address.id, address.user_id);
        });
        claimed = 'claimed';
    }
    if (claimed === 'claimed') return { ok: false, error: 'This address has already been verified for another account. Remove it from this account and use a different address.' };
    return claimed ? { ok: true, user: await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id), email: row.email } : { ok: false, error: 'This verification link was already used.' };
}

module.exports = { meRouter, verifiedCheckRouter, consume, selectedForClient };
