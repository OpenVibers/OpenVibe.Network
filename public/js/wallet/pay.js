/* openvibe.network/pay/:id — the Vibes Pay sheet (MONEY.md, D12).
 *
 * A centred card, 420 px at most: the app and "on OpenVibe", the item, one large price in whole Vibes, the person's
 * Vibes, one primary button (or Get Vibes when they are short), and a quiet Cancel. It never draws a card form: the
 * Vibes are already bought. Opened as a popup it posts { status } to the opener — only at the origin of the
 * registered return_url — and closes; as a full page it stays and links back to the app.
 */
(function () {
    'use strict';

    const W = window.OVWallet;
    const M = window.OVWalletMoney;
    const S = window.OVWalletSheets;
    if (!W || !M) return;

    const root = document.getElementById('w-pay-card');
    let charge = null;
    let wallet = null;
    let state = 'loading';

    function idFromPath() {
        const parts = String(location.pathname || '').split('/').filter(Boolean);
        const raw = parts.length ? parts[parts.length - 1] : '';
        try { return decodeURIComponent(raw); } catch { return raw; }
    }

    const chargeId = idFromPath();

    function randomKey() {
        try { if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID(); } catch { /* older browser */ }
        return `pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }

    function card() {
        const box = W.el('div', 'w-pay');
        root.replaceChildren();
        root.appendChild(box);
        return box;
    }

    function appOf(out, fallback) {
        const c = out && out.charge ? out.charge : out;
        if (!c || typeof c !== 'object' || !c.id) return null;
        const app = c.app && typeof c.app === 'object' ? c.app : (out && out.app && typeof out.app === 'object' ? out.app : {});
        const before = fallback || {};
        const name = app.name || c.app_name || (out && out.app_name) || (before.app && before.app.name) || 'An OpenVibe app';
        const icon = app.icon || app.icon_url || c.app_icon || (out && out.app_icon) || (before.app && before.app.icon) || null;
        let amount = Number(c.amount);
        if (!Number.isSafeInteger(amount) || amount < 0) amount = Number(before.amount);
        if (!Number.isSafeInteger(amount) || amount < 0) return null;
        const status = String(c.status || before.status || 'pending');
        return {
            id: String(c.id),
            app: { name: String(name).slice(0, 80), icon },
            description: String(c.description || before.description || 'A purchase on OpenVibe').slice(0, 200),
            amount,
            status,
            returnUrl: c.return_url || before.returnUrl || null,
            expiresAt: c.expires_at || before.expiresAt || null,
            reference: c.reference || before.reference || null,
        };
    }

    function creditOf(out) {
        if (!out) return null;
        const candidates = [
            out.vibes && out.vibes.credit, out.credit, out.vibes_credit,
            out.wallet && out.wallet.credit, out.charge && out.charge.vibes_credit,
        ];
        for (const c of candidates) if (c != null && Number.isSafeInteger(Number(c))) return Number(c);
        return null;
    }

    function expired(c) {
        if (!c || !c.expiresAt) return false;
        const t = new Date(c.expiresAt).getTime();
        return Number.isFinite(t) && t > 0 && t < Date.now();
    }

    function creditNow() {
        if (wallet && wallet.vibes && wallet.vibes.credit != null && Number.isFinite(Number(wallet.vibes.credit))) return Number(wallet.vibes.credit);
        return null;
    }

    function safeIcon(raw) {
        const u = W.httpsUrl(raw);
        if (!u) return null;
        const h = u.hostname.toLowerCase();
        if (h === 'openvibe.media' || h === 'openvibe.live' || u.origin === location.origin) return u.href;
        return null;
    }

    function appMark(c) {
        const wrap = W.el('span', 'w-pay-mark');
        const src = safeIcon(c.app.icon);
        if (src) {
            const img = document.createElement('img');
            img.src = src;
            img.alt = '';
            img.width = 48;
            img.height = 48;
            img.addEventListener('error', () => { wrap.replaceChildren(W.el('span', 'w-pay-mark-initial', initial(c))); });
            wrap.appendChild(img);
        } else {
            wrap.appendChild(W.el('span', 'w-pay-mark-initial', initial(c)));
        }
        return wrap;
    }

    function initial(c) {
        const m = String(c.app.name || 'O').match(/[A-Za-z0-9]/);
        return (m ? m[0] : 'O').toUpperCase();
    }

    function appLine(c, small) {
        const row = W.el('div', 'w-pay-app');
        row.appendChild(appMark(c));
        const who = W.el('div', 'w-pay-app-who');
        who.appendChild(W.el('b', null, c.app.name));
        who.appendChild(W.el('span', null, small || 'on OpenVibe'));
        row.appendChild(who);
        return row;
    }

    function backLink(c) {
        const u = W.httpsUrl(c.returnUrl);
        if (!u) return null;
        const a = W.el('a', 'ovk-btn ovk-btn--primary w-pay-go', `Back to ${c.app.name}`);
        a.href = u.href;
        a.rel = 'noopener';
        a.addEventListener('click', () => { if (window.opener && !window.opener.closed) setTimeout(() => { try { window.close(); } catch { /* */ } }, 0); });
        return a;
    }

    function quietCancel(label, onClick) {
        const b = W.el('button', 'w-quiet w-pay-cancel', label || 'Cancel');
        b.type = 'button';
        if (onClick) b.addEventListener('click', onClick);
        return b;
    }

    function quietLink(href, label) {
        const a = W.el('a', 'w-quiet w-pay-cancel', label);
        a.href = href;
        return a;
    }

    function frame(children) {
        const box = card();
        for (const child of children) if (child) box.appendChild(child);
        return box;
    }

    function sentence(text) {
        return frame([W.el('p', 'w-pay-sentence', text)]);
    }

    // ── The document the opener receives ─────────────────────
    function tellOpener(status) {
        const c = charge;
        const u = c ? W.httpsUrl(c.returnUrl) : null;
        if (!u || !window.opener || window.opener.closed) return;
        try { window.opener.postMessage({ type: 'ov-vibes-pay', status, charge_id: c.id }, u.origin); } catch { /* a closed or cross-origin opener */ }
    }

    function closeAsPopupIfAny(status) {
        const c = charge;
        const u = c ? W.httpsUrl(c.returnUrl) : null;
        if (!u || !window.opener || window.opener.closed) return;
        tellOpener(status);
        setTimeout(() => { try { window.close(); } catch { /* not opened by script */ } }, 1400);
    }

    // ── The states ───────────────────────────────────────────
    function renderUnavailable() {
        state = 'unavailable';
        sentence("This payment link isn't available. It may be old, or for another account.");
        const box = root.querySelector('.w-pay');
        box.appendChild(quietLink('/wallet', 'Go to your wallet'));
    }

    function renderStatusSentence(text) {
        sentence(text);
        const box = root.querySelector('.w-pay');
        const c = charge;
        const u = c ? W.httpsUrl(c.returnUrl) : null;
        if (u) box.appendChild(quietLink(u.href, `Back to ${c.app.name}`));
        else box.appendChild(quietLink('/wallet', 'Go to your wallet'));
    }

    function renderPaid() {
        state = 'paid';
        const c = charge;
        const box = card();
        const check = W.el('span', 'w-pay-check');
        check.setAttribute('aria-hidden', 'true');
        check.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.2 5L20 6.8"/></svg>';
        box.appendChild(check);
        box.appendChild(W.el('h1', 'w-pay-title', 'Paid'));
        box.appendChild(W.el('p', 'w-pay-line', `${M.vibes(c.amount)} Vibes to ${c.app.name}.`));
        box.appendChild(appLine(c, 'paid'));
        const back = backLink(c);
        if (back) box.appendChild(back);
        else box.appendChild(quietLink('/wallet', 'Go to your wallet'));
        if (window.opener && !window.opener.closed) closeAsPopupIfAny('paid');
    }

    function renderShort(c, credit) {
        state = 'short';
        const box = card();
        box.appendChild(appLine(c));
        box.appendChild(W.el('p', 'w-pay-item', c.description));
        box.appendChild(W.el('p', 'w-pay-price', `${M.vibes(c.amount)} Vibes`));
        box.appendChild(W.el('p', 'w-pay-have', `You have ${M.vibes(credit)} Vibes`));
        const need = c.amount - credit;
        box.appendChild(W.el('p', 'w-pay-need', `You need ${M.vibes(need)} more Vibes`));
        const get = W.el('button', 'ovk-btn ovk-btn--primary w-pay-go', 'Get Vibes');
        get.type = 'button';
        get.addEventListener('click', () => S.openVibes({
            rates: wallet && wallet.rates,
            bitsPerUsd: wallet && wallet.vibes && wallet.vibes.bits_per_usd,
            balanceNano: wallet && wallet.balance && wallet.balance.personal ? wallet.balance.personal.available_nano_usd : null,
            canBuy: !!(wallet && wallet.state && wallet.state.vibes === 'open'),
            onDone: async () => { await refresh(); },
        }));
        box.appendChild(get);
        box.appendChild(quietCancel('Cancel', cancelCharge));
    }

    function renderPayable(c, credit) {
        state = 'payable';
        const box = card();
        box.appendChild(appLine(c));
        box.appendChild(W.el('p', 'w-pay-item', c.description));
        box.appendChild(W.el('p', 'w-pay-price', `${M.vibes(c.amount)} Vibes`));
        box.appendChild(W.el('p', 'w-pay-have', `You have ${M.vibes(credit)} Vibes`));
        const pay = W.el('button', 'ovk-btn ovk-btn--primary w-pay-go', `Pay ${M.vibes(c.amount)} Vibes`);
        pay.type = 'button';
        pay.addEventListener('click', () => payCharge(pay));
        box.appendChild(pay);
        box.appendChild(quietCancel('Cancel', cancelCharge));
    }

    function renderError(text) {
        const box = root.querySelector('.w-pay') || card();
        let line = box.querySelector('.w-pay-error');
        if (!line) { line = W.el('p', 'w-pay-error'); box.appendChild(line); }
        line.textContent = text;
    }

    function render() {
        if (!charge) return renderUnavailable();
        const c = charge;
        if (c.status === 'paid') return renderPaid();
        if (c.status === 'refunded') return renderStatusSentence('This payment was refunded to your Vibes.');
        if (c.status === 'cancelled') {
            state = 'cancelled';
            renderStatusSentence('This payment was cancelled.');
            closeAsPopupIfAny('cancelled');
            return;
        }
        if (c.status === 'expired' || expired(c)) {
            state = 'expired';
            renderStatusSentence('This payment link has expired.');
            return;
        }
        const credit = creditNow();
        if (credit == null) {
            state = 'unknown';
            return sentence("Your Vibes aren't available right now. Try again in a moment.");
        }
        const canPay = credit >= c.amount;
        if (!canPay) return renderShort(c, credit);
        renderPayable(c, credit);
    }

    // ── Actions ──────────────────────────────────────────────
    async function payCharge(button) {
        if (state !== 'payable' || !charge) return;
        button.disabled = true;
        button.textContent = 'Paying…';
        try {
            const out = await W.api(`/api/wallet/charge/${encodeURIComponent(charge.id)}/pay`, { method: 'POST', body: { idempotency_key: randomKey() } });
            const next = appOf(out, charge);
            if (next) charge = next;
            else charge = Object.assign(charge, { status: 'paid' });
            // The answer may be the paid charge, or a wrapper { charge, vibes }; take its credit too.
            const credit = creditOf(out);
            if (credit != null) wallet = Object.assign(wallet || {}, { vibes: { credit } });
            renderPaid();
        } catch (e) {
            if (e.status === 402) {
                // Somebody or something moved the Vibes between the read and the pay: show the shortfall and Get Vibes.
                await refresh();
                if (state !== 'paid') renderError('You need a few more Vibes for this one.');
                return;
            }
            button.disabled = false;
            button.textContent = `Pay ${M.vibes(charge.amount)} Vibes`;
            renderError(e.status === 409 ? 'This payment can no longer be paid.' : 'The payment could not go through. Try again in a moment.');
        }
    }

    async function cancelCharge() {
        if (!charge) return;
        if (state === 'cancelled' || state === 'paid') return;
        try {
            await W.api(`/api/wallet/charge/${encodeURIComponent(charge.id)}/cancel`, { method: 'POST', body: {} });
            charge.status = 'cancelled';
            render();
        } catch {
            renderError('The payment could not be cancelled.');
        }
    }

    async function refresh() {
        const [out, w] = await Promise.allSettled([
            W.api(`/api/wallet/charge/${encodeURIComponent(chargeId)}`),
            W.api('/api/wallet'),
        ]);
        if (w.status === 'fulfilled') wallet = w.value;
        if (out.status === 'fulfilled') {
            const next = appOf(out.value, charge);
            if (next) {
                charge = next;
                const credit = creditOf(out.value);
                if (credit != null) wallet = Object.assign(wallet || {}, { vibes: { credit } });
                render();
                return;
            }
        }
        if (out.status === 'rejected' && (out.reason.status === 404 || out.reason.status === 400)) { charge = null; renderUnavailable(); return; }
        if (!root.querySelector('.w-pay')) sentence("This payment link isn't available right now.");
        else renderError("This payment link isn't available right now.");
    }

    (async function start() {
        // The person must be signed in; the sign-in page returns them to this exact link.
        const user = await W.person();
        if (!user) return;
        W.navbar(user);
        if (!/^vch_[0-9A-HJKMNP-TV-Z]{26}$/.test(chargeId)) { renderUnavailable(); return; }
        await refresh();
        document.title = charge ? `Pay ${M.vibes(charge.amount)} Vibes - ${charge.app.name}` : 'Vibes Pay - OpenVibe';
    })().catch(() => {
        if (!root.querySelector('.w-pay')) sentence("This payment link isn't available right now.");
    });
}());
