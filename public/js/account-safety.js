/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account safety helpers, on every page:
   - OpenVibeReauth: the one re-authentication path. A fresh sign-in action (deleting the account, merging two
     accounts, the owner's AI key/money settings, Locker reset/forget) sends people to
     /login?reauth=1&return=<where to come back to>. That page always asks for the password, even when a session
     already exists; add_account=1 reuses the existing session and leaves auth_time alone, which is exactly the
     loop this replaces.
   - OpenVibeDeletion: while a deletion is scheduled, a banner on every page says when, with one button that
     keeps the account (DELETE /api/v1/account/deletion). The sign-in page shows the same choice before it
     continues (see login.js).

   Classic script, no modules: it is loaded on the static pages and the server-rendered ones alike.
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
    'use strict';
    const REAUTH_WINDOW_S = 10 * 60;
    const BANNER_ID = 'ov-deletion-banner';

    function base() {
        return (root && root.location && root.location.origin) || '';
    }

    function cookieToken() {
        try {
            const m = String(root.document && root.document.cookie || '').match(/(?:^|; )ov_token=([^;]*)/);
            return m ? decodeURIComponent(m[1]) : null;
        } catch { return null; }
    }

    function storedAccounts() {
        try { return JSON.parse(root.localStorage.getItem('openvibe_accounts') || '[]'); } catch { return []; }
    }

    /** The active person's token: the same rule as /my's getAuthToken (never an anonymous session). */
    function sessionToken() {
        try {
            const activeId = root.localStorage.getItem('openvibe_active_account');
            if (activeId === 'anon') return null;
            const account = storedAccounts().find((a) => String(a.id) === String(activeId));
            if (account && account.is_anon) return null;
            return root.localStorage.getItem('ov_token') || (account && account.token) || cookieToken() || null;
        } catch { return null; }
    }

    /** The one re-authentication URL. `account` prefills the username; pass '' to leave it blank (merge). */
    function reauthUrl(returnTo, options) {
        const params = new URLSearchParams();
        params.set('reauth', '1');
        if (options && Object.prototype.hasOwnProperty.call(options, 'account')) params.set('login_hint', String(options.account || ''));
        params.set('return', String(returnTo || '/'));
        return '/login?' + params.toString();
    }

    function goReauth(returnTo, options) {
        if (root.location) root.location.href = reauthUrl(returnTo, options);
    }

    function formatWhen(value) {
        const d = new Date(value);
        if (!Number.isFinite(d.getTime())) return 'the date in your account settings';
        try { return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return d.toISOString(); }
    }

    function bannerText(deleteAfter) {
        return `Your account will be deleted on ${formatWhen(deleteAfter)}.`;
    }

    async function deletionStatus(token) {
        const t = token || sessionToken();
        if (!t) return null;
        const res = await fetch(base() + '/api/v1/account/deletion', {
            headers: { Authorization: 'Bearer ' + t },
            credentials: 'include',
        });
        if (!res.ok) return null;
        const body = await res.json().catch(() => ({}));
        return body && body.deletion ? body.deletion : null;
    }

    async function cancelDeletion(token) {
        const t = token || sessionToken();
        if (!t) return { ok: false, status: 401, body: {} };
        const res = await fetch(base() + '/api/v1/account/deletion', {
            method: 'DELETE',
            headers: { Authorization: 'Bearer ' + t },
            credentials: 'include',
        });
        let body = {};
        try { body = await res.json(); } catch { /* no body */ }
        return { ok: res.ok, status: res.status, body };
    }

    function removeBanner() {
        const doc = root && root.document;
        if (!doc) return;
        const el = doc.getElementById(BANNER_ID);
        if (el) el.remove();
        if (doc.body) doc.body.style.paddingBottom = '';
    }

    function buttonStyle() {
        return 'appearance:none;border:0;border-radius:999px;padding:8px 16px;background:var(--accent,#3b82f6);'
            + 'color:#fff;font:600 13px/1.2 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;'
            + 'box-shadow:0 2px 8px rgba(59,130,246,.35);white-space:nowrap';
    }

    function showBanner(deletion) {
        const doc = root && root.document;
        if (!doc || !doc.body) return;
        let el = doc.getElementById(BANNER_ID);
        if (!el) {
            el = doc.createElement('div');
            el.id = BANNER_ID;
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:10050;display:flex;align-items:center;'
                + 'justify-content:center;gap:12px;flex-wrap:wrap;padding:12px 18px;'
                + 'padding-bottom:max(12px,env(safe-area-inset-bottom));background:var(--bg-secondary,#101828);'
                + 'border-top:1px solid var(--border,#2c3d5c);box-shadow:0 -8px 28px rgba(0,0,0,.35);'
                + 'font:14px/1.4 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text-primary,#e6edf7);'
                + 'text-align:center';
            const text = doc.createElement('span');
            text.setAttribute('data-ov-deletion-text', '');
            const button = doc.createElement('button');
            button.type = 'button';
            button.id = 'ov-deletion-keep';
            button.textContent = 'Keep my account';
            button.style.cssText = buttonStyle();
            button.addEventListener('click', async () => {
                button.disabled = true;
                button.textContent = 'Keeping…';
                const result = await cancelDeletion();
                if (!result.ok && result.status !== 404) {
                    button.disabled = false;
                    button.textContent = 'Keep my account';
                    text.textContent = (result.body && result.body.detail) || 'That did not work. Try again.';
                    return;
                }
                text.textContent = 'Kept. Your account stays.';
                setTimeout(removeBanner, 900);
                try { root.dispatchEvent(new root.CustomEvent('ov:deletion-cancelled', { detail: result.body })); } catch { /* no CustomEvent */ }
            });
            el.append(text, button);
            doc.body.appendChild(el);
            const height = Number(el.offsetHeight) || 0;
            if (height) doc.body.style.paddingBottom = height + 'px';
        }
        const text = el.querySelector('[data-ov-deletion-text]');
        if (text) text.textContent = bannerText(deletion.delete_after);
    }

    async function refreshBanner() {
        if (!sessionToken()) return null;
        const deletion = await deletionStatus();
        if (deletion) showBanner(deletion);
        else removeBanner();
        return deletion;
    }

    const api = {
        REAUTH_WINDOW_S, BANNER_ID, sessionToken, reauthUrl, goReauth, formatWhen, bannerText,
        deletionStatus, cancelDeletion, refreshBanner, showBanner, removeBanner,
    };
    if (root) {
        root.OpenVibeReauth = { url: reauthUrl, go: goReauth, WINDOW_S: REAUTH_WINDOW_S };
        root.OpenVibeDeletion = api;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    if (root && root.document) {
        const start = () => { refreshBanner().catch(() => { /* signed out, offline: no banner */ }); };
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    }
})(typeof window !== 'undefined' ? window : globalThis);
