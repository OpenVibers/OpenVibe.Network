/* openvibe.network/wallet — what both wallet pages share: the person's token, the API call, the shared navbar, and
 * the small DOM helpers. Classic script, no modules: /wallet and /pay load it before their own script.
 */
(function (root) {
    'use strict';

    const API = root.location.origin;
    const WALLET_MENU = {
        before: [{ id: 'ov-wallet', label: 'Wallet', short: 'Wallet', icon: 'fa-wallet', href: 'https://openvibe.network/wallet' }],
    };

    // A signed-out wallet replaces itself with /login, which does not load the kit and so does not opt in to
    // cross-document view transitions; Chrome aborts the transition and leaves an uncaught InvalidStateError
    // ("ViewTransition opt-in disabled"). Shared's account switcher handles the same 11-01 bug: a replace navigation
    // is a redirect, not a page move, so skip its transition and keep all three transition promises handled.
    function quietViewTransition(event) {
        const transition = event && event.viewTransition;
        if (!transition) return;
        for (const promise of [transition.finished, transition.ready, transition.updateCallbackDone]) {
            try { if (promise && typeof promise.catch === 'function') promise.catch(() => {}); } catch { /* not a promise */ }
        }
        const activation = event.activation;
        if (!activation || activation.navigationType !== 'replace') return;
        try { if (typeof transition.skipTransition === 'function') transition.skipTransition(); } catch { /* already gone */ }
    }
    if (typeof root.addEventListener === 'function') {
        root.addEventListener('pageswap', quietViewTransition);
        root.addEventListener('pagereveal', quietViewTransition);
    }

    function cookieToken() {
        const m = String(document.cookie || '').match(/(?:^|; )ov_token=([^;]*)/);
        return m ? decodeURIComponent(m[1]) : null;
    }

    function storedAccountToken() {
        try {
            const id = localStorage.getItem('openvibe_active_account');
            const list = JSON.parse(localStorage.getItem('openvibe_accounts') || '[]');
            const a = list.find((x) => x && String(x.id) === String(id) && x.token && !x.is_anon);
            return a ? a.token : null;
        } catch { return null; }
    }

    /** The person's token, kept where every OpenVibe page keeps it. Null for a guest. */
    function token() {
        try { if (localStorage.getItem('openvibe_active_account') === 'anon') return null; } catch { /* private mode */ }
        return localStorage.getItem('ov_token') || storedAccountToken() || cookieToken();
    }

    function signInReturn() {
        return `/login?return=${encodeURIComponent(root.location.pathname + root.location.search)}`;
    }

    /** A JSON call to Network's own API with the person's token. Throws { status, code, detail }. */
    async function api(path, options = {}) {
        const headers = Object.assign({ accept: 'application/json' }, options.headers || {});
        const t = token();
        if (t) headers.authorization = `Bearer ${t}`;
        if (options.body !== undefined) headers['content-type'] = 'application/json';
        const r = await fetch(API + path, {
            method: options.method || 'GET',
            headers,
            credentials: 'include',
            cache: 'no-store',
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });
        let body = null;
        try { body = await r.json(); } catch { /* a non-JSON refusal */ }
        if (!r.ok) {
            const err = new Error((body && (body.detail || body.error)) || `Request failed (${r.status})`);
            err.status = r.status;
            err.code = body && body.error;
            err.body = body;
            throw err;
        }
        return body;
    }

    /** The person, from Network's session; sends a guest to sign in and back to this page. */
    async function person() {
        if (!token()) { root.location.replace(signInReturn()); return null; }
        try {
            const me = await api('/api/auth/me');
            return me && me.user ? me.user : null;
        } catch (e) {
            if (e.status === 401 || e.status === 403) { root.location.replace(signInReturn()); return null; }
            throw e;
        }
    }

    /** The shared navbar, with Wallet in the account menu on Network's own pages. */
    function navbar(user) {
        if (!root.OpenVibeNavbar) return;
        try {
            root.OpenVibeNavbar.init({
                service: 'network', notificationsRealtime: true, token: token(), user,
                menu: WALLET_MENU,
                links: [{ label: 'Link', href: 'https://openvibe.link', icon: 'fa-desktop', featured: true }, { label: 'Wallet', href: '/wallet' }, { label: 'My Account', href: 'https://openvibe.my/' }],
            });
        } catch { /* the page works without it */ }
    }

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    function icon(pathD, size = 20) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 512 512');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('class', 'w-icon');
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', pathD);
        path.setAttribute('fill', 'currentColor');
        svg.appendChild(path);
        return svg;
    }

    /** A date a screen reader and the eye both read: "Nov 4, 2026", "14:32" in the title. */
    function when(iso) {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return { date: '', time: '' };
        return {
            date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            time: d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        };
    }

    /** Only an https URL, never javascript: or data:. */
    function httpsUrl(raw) {
        try {
            const u = new URL(String(raw || ''));
            return u.protocol === 'https:' && u.hostname ? u : null;
        } catch { return null; }
    }

    function closeOnBackdrop(dialog) {
        dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    }

    root.OVWallet = { API, api, person, token, navbar, el, icon, when, httpsUrl, closeOnBackdrop, signInReturn };
}(window));
