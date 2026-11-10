/* openvibe.network/wallet — the one wallet (MONEY.md, D12).
 *
 * Three cards — Balance (nano-USD, dollars), Vibes (whole numbers) and OpenCoins — then the person's projects and
 * one activity list over both currencies. Every amount comes from Network's /api/wallet (which forwards the person's
 * token to Billing) as an integer; this file only formats it. No spinner: loading is a written word.
 */
(function () {
    'use strict';

    const W = window.OVWallet;
    const M = window.OVWalletMoney;
    const S = window.OVWalletSheets;
    if (!W || !M) return;

    const GLYPH = {
        vibes: 'M64 43Q37 44 19 62Q1 80 0 107V427Q1 454 19 472Q37 490 64 491H448Q475 490 493 472Q511 454 512 427V203Q511 176 493 158Q475 140 448 139H80Q65 138 64 123Q65 108 80 107H448Q462 107 471 98Q480 89 480 75Q480 61 471 52Q462 43 448 43H64ZM416 283Q430 283 439 292Q448 301 448 315Q448 329 439 338Q430 347 416 347Q402 347 393 338Q384 329 384 315Q384 301 393 292Q402 283 416 283Z',
        coins: 'M512 91Q511 118 474 139Q428 164 351 170Q346 167 340 165Q279 140 192 139Q180 139 168 140L166 139Q129 118 128 91Q130 57 184 34Q238 12 320 11Q402 12 456 34Q510 57 512 91ZM161 172Q176 171 192 171Q239 171 278 180Q318 188 345 202Q383 223 384 251Q384 257 382 263Q374 283 347 298Q347 298 347 298Q347 298 347 298Q347 298 347 298Q347 298 347 298Q346 299 346 299Q346 299 346 299Q319 314 279 322Q240 331 192 331Q100 330 44 302Q41 300 38 299Q1 278 0 251Q1 224 36 204Q71 184 128 176Q144 173 161 172ZM416 251Q414 218 392 198Q435 191 468 177Q493 167 512 152V187Q511 217 468 238Q446 249 416 256Q416 256 416 256Q416 254 416 251ZM384 347Q383 374 346 395Q344 396 342 397Q341 397 340 398Q284 426 192 427Q144 427 105 418Q65 410 38 395Q1 374 0 347V312Q19 327 44 337Q105 362 192 363Q279 362 340 337Q352 332 363 326Q372 321 380 315Q381 314 383 313Q383 312 384 312V315V321V347ZM416 347V315V347V315V289Q445 283 468 273Q493 263 512 248V283Q512 299 497 314Q471 339 416 352Q416 350 416 347ZM192 459Q279 458 340 433Q365 423 384 408V443Q382 477 328 500Q274 522 192 523Q110 522 56 500Q2 477 0 443V408Q19 423 44 433Q105 458 192 459Z',
    };

    const $ = (id) => document.getElementById(id);
    let DATA = null;
    let filter = 'all';
    let transfer = { project: null, key: null, fixed: false };

    function randomKey() {
        try { if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID(); } catch { /* older browser */ }
        return `wallet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }

    function banner(text, retry) {
        const b = $('w-banner');
        b.replaceChildren();
        if (!text) { b.hidden = true; return; }
        b.hidden = false;
        b.append(document.createTextNode(text));
        if (retry) {
            const btn = W.el('button', 'w-linkish', 'Try again');
            btn.type = 'button';
            btn.addEventListener('click', () => load());
            b.append(document.createTextNode(' '), btn);
        }
    }

    function note(id, text, tone) {
        const n = $(id);
        if (!text) { n.hidden = true; n.textContent = ''; n.className = 'w-note'; return; }
        n.hidden = false;
        n.textContent = text;
        n.className = `w-note${tone ? ` is-${tone}` : ''}`;
    }

    /** The projects list in the shared shape (Balance's answer may not be open yet). */
    function projects() {
        return DATA && Array.isArray(DATA.projects) ? DATA.projects : [];
    }

    function balanceOpen() { return !!(DATA && DATA.state && DATA.state.balance === 'open' && DATA.balance); }

    function vibesCount() {
        return DATA && DATA.vibes && Number.isFinite(Number(DATA.vibes.credit)) ? Number(DATA.vibes.credit) : 0;
    }

    function renderCards() {
        const personal = DATA && DATA.balance && DATA.balance.personal ? DATA.balance.personal : null;
        $('w-balance-amount').textContent = personal ? M.money(personal.balance_nano_usd) : (DATA && DATA.state.balance === 'closed' ? M.money(0) : '—');
        if (DATA && DATA.state.balance === 'closed') {
            note('w-balance-note', "Balance isn't open yet. When it is, Add money puts dollars here for the AI API and the pro tools.", 'quiet');
        } else if (DATA && DATA.state.balance === 'unavailable') {
            note('w-balance-note', "Your Balance couldn't load.", 'warn');
        } else if (personal && BigInt(String(personal.held_nano_usd || '0')) > 0n) {
            note('w-balance-note', `${M.money(personal.held_nano_usd)} is held for work that is running now.`, 'quiet');
        } else {
            note('w-balance-note', '');
        }

        $('w-vibes-amount').textContent = DATA && DATA.state.vibes === 'open' ? M.vibes(vibesCount()) : (DATA && DATA.state.vibes === 'closed' ? M.vibes(0) : '—');
        note('w-vibes-note', DATA && DATA.state.vibes === 'not_authoritative' ? "Vibes aren't in this wallet until Billing takes them over." :
            DATA && DATA.state.vibes === 'unavailable' ? "Your Vibes couldn't load." :
                DATA && !vibesOpen() ? "Vibes aren't open yet. When they are, Get Vibes buys them, or moves dollars from your Balance." : '', 'quiet');

        $('w-coins-amount').textContent = DATA ? M.vibes(DATA.opencoins) : '—';
    }

    /** Vibes can be had when they are open (buy) or when Balance is (move dollars into Vibes). */
    function vibesOpen() { return !!(DATA && DATA.state && (DATA.state.vibes === 'open' || balanceOpen())); }

    // A primary button promises the action works. While a currency is not open, its button is a quiet "Opening soon"
    // that cannot be pressed, and the card's note says why; once it opens, the button is the primary action again.
    function setAction(id, open, label, closedTitle) {
        const btn = $(id);
        const closed = DATA && DATA.state && !open;
        btn.disabled = !open;
        btn.textContent = closed ? 'Opening soon' : label;
        btn.classList.toggle('ovk-btn--primary', !closed);
        btn.classList.toggle('ovk-btn--quiet', closed);
        btn.title = closed ? closedTitle : '';
    }
    function renderActions() {
        setAction('w-add-money', balanceOpen(), 'Add money', "Balance isn't open yet");
        const move = $('w-move');
        move.disabled = !balanceOpen();
        move.title = balanceOpen() ? '' : "Balance isn't open yet";
        setAction('w-get-vibes', vibesOpen(), 'Get Vibes', "Vibes aren't open yet");
    }

    function renderProjects() {
        const list = $('w-projects');
        list.replaceChildren();
        const rows = projects();
        $('w-projects-empty').hidden = rows.length > 0;
        for (const p of rows) {
            const li = W.el('li', 'w-project');
            const main = W.el('div', 'w-project-main');
            const a = W.el('a', 'w-project-link');
            a.href = p.url;
            a.target = '_blank';
            a.rel = 'noopener';
            a.title = `${p.name || 'Project'} on openvibe.services`;
            a.append(W.el('b', null, p.name || 'Project'), W.el('span', 'w-project-ext', '↗'));
            main.appendChild(a);
            let held = 0n;
            try { held = BigInt(String(p.held_nano_usd || '0')); } catch { held = 0n; }
            if (held > 0n) main.appendChild(W.el('span', 'w-project-sub', `Available ${M.money(p.available_nano_usd)}`));
            const side = W.el('div', 'w-project-side');
            side.appendChild(W.el('span', 'w-project-bal', M.money(p.balance_nano_usd)));
            const add = W.el('button', 'ovk-btn ovk-btn--quiet ovk-btn--small', 'Add');
            add.type = 'button';
            add.disabled = !balanceOpen();
            add.title = balanceOpen() ? `Move money from your Balance to ${p.name || 'this project'}` : 'Your Balance is not open yet';
            add.addEventListener('click', () => openTransfer(p.id));
            side.appendChild(add);
            li.append(main, side);
            list.appendChild(li);
        }
    }

    function activityParts(row) {
        if (Array.isArray(row.parts) && row.parts.length) return row.parts;
        return row.kind ? [{ kind: row.kind, amount: row.amount }] : [];
    }

    function activityRow(row) {
        const li = W.el('li', 'w-act');
        const parts = activityParts(row);
        const kinds = parts.map((p) => p.kind);
        li.dataset.kinds = kinds.join(' ');
        const t = W.when(row.at);
        const date = W.el('time', 'w-act-date', t.date);
        date.dateTime = String(row.at || '');
        if (t.time) date.title = t.time;
        const main = W.el('div', 'w-act-main');
        // The reason is a sentence from billing.money-reason@1; when it names a thing with a page, the
        // sentence is the link to it. The raw ledger key is never drawn.
        const label = String(row.label || 'Activity');
        const url = row.subject && row.subject.url;
        if (url && /^https:\/\//.test(url)) {
            const a = W.el('a', 'w-act-label', label);
            a.href = url; a.target = '_blank'; a.rel = 'noopener';
            main.appendChild(a);
        } else main.appendChild(W.el('b', 'w-act-label', label));
        const kindNames = [...new Set(kinds.map((k) => (k === 'vibes' ? 'Vibes' : 'Balance')))];
        const kindName = kindNames.join(' · ');
        main.appendChild(W.el('span', 'w-act-detail', row.detail ? `${kindName} · ${row.detail}` : kindName));
        const amt = W.el('span', `w-act-amt${parts.length > 1 ? ' w-act-amt--stack' : ''}`);
        for (const part of parts) {
            const signed = part.kind === 'balance'
                ? M.signedMoney(part.amount)
                : { sign: Number(part.amount) < 0 ? '−' : '+', text: M.vibes(Math.abs(Number(part.amount))) };
            const line = W.el('span', `w-act-part ${signed.sign === '+' ? 'is-pos' : 'is-neg'}`);
            line.append(document.createTextNode(`${signed.sign}${signed.text}`));
            if (part.kind === 'vibes') line.appendChild(W.el('small', null, 'Vibes'));
            amt.appendChild(line);
        }
        li.append(date, main, amt);
        return li;
    }

    function renderActivity() {
        const list = $('w-activity');
        list.replaceChildren();
        const rows = DATA && Array.isArray(DATA.activity) ? DATA.activity : [];
        for (const row of rows) list.appendChild(activityRow(row));
        applyFilter();
    }

    function applyFilter() {
        const rows = DATA && Array.isArray(DATA.activity) ? DATA.activity : [];
        const items = $('w-activity').children;
        let shown = 0;
        for (const li of items) {
            const ok = filter === 'all' || String(li.dataset.kinds || '').split(' ').includes(filter);
            li.hidden = !ok;
            if (ok) shown++;
        }
        const empty = $('w-activity-empty');
        const total = rows.length;
        empty.hidden = total > 0;
        if (total === 0) empty.textContent = 'No activity yet. Add money or get Vibes and it will show here.';
        else if (shown === 0) { empty.hidden = false; empty.textContent = filter === 'balance' ? 'No Balance activity yet.' : 'No Vibes activity yet.'; }
        for (const chip of document.querySelectorAll('.w-chip')) chip.setAttribute('aria-pressed', String(chip.dataset.filter === filter));
    }

    function fillGlyphs() {
        for (const el of document.querySelectorAll('[data-glyph]')) {
            const d = GLYPH[el.getAttribute('data-glyph')];
            if (!d) continue;
            el.replaceChildren(W.icon(d, 22));
        }
    }

    // ── Move money ───────────────────────────────────────────
    function transferAvailable() {
        const p = DATA && DATA.balance && DATA.balance.personal;
        return p ? BigInt(String(p.available_nano_usd || '0')) : 0n;
    }

    function openTransfer(projectId) {
        const dialog = $('w-transfer-dialog');
        transfer = { project: projectId || '', key: randomKey(), fixed: !!projectId };
        const select = $('w-transfer-project');
        select.replaceChildren();
        for (const p of projects()) {
            const o = document.createElement('option');
            o.value = p.id;
            o.textContent = p.name || p.id;
            select.appendChild(o);
        }
        select.value = projectId || (projects()[0] && projects()[0].id) || '';
        $('w-transfer-project-field').hidden = !!projectId;
        $('w-transfer-lede').textContent = projectId
            ? `Move money from your Balance into ${(projects().find((p) => p.id === projectId) || {}).name || 'this project'}.`
            : "Move money from your Balance into a project's Balance.";
        $('w-transfer-have').textContent = M.money(transferAvailable());
        $('w-transfer-amount').value = '';
        $('w-transfer-go').textContent = 'Move money';
        $('w-transfer-go').disabled = true;
        const state = $('w-transfer-state');
        state.textContent = balanceOpen() ? '' : 'Your Balance is not open yet.';
        if (!dialog.open) dialog.showModal();
        setTimeout(() => $('w-transfer-amount').focus(), 0);
    }

    function updateTransfer() {
        const nano = M.dollarsToNano($('w-transfer-amount').value);
        const go = $('w-transfer-go');
        if (!nano || BigInt(nano) <= 0n) { go.disabled = true; go.textContent = 'Move money'; return; }
        const available = transferAvailable();
        const over = BigInt(nano) > available;
        go.disabled = over || !balanceOpen();
        go.textContent = over ? 'Not enough Balance' : `Move ${M.money(nano)}`;
        $('w-transfer-state').textContent = over ? `You have ${M.money(available)} available.` : '';
    }

    async function submitTransfer() {
        const nano = M.dollarsToNano($('w-transfer-amount').value);
        const projectId = transfer.fixed ? transfer.project : $('w-transfer-project').value;
        if (!nano || !projectId) return;
        const go = $('w-transfer-go');
        const state = $('w-transfer-state');
        go.disabled = true;
        state.textContent = 'Moving…';
        try {
            await W.api('/api/wallet/transfers', { method: 'POST', body: { to_project_id: projectId, amount_nano_usd: nano, idempotency_key: transfer.key } });
            $('w-transfer-dialog').close();
            const name = (projects().find((p) => p.id === projectId) || {}).name || 'the project';
            await load();
            banner(`Moved ${M.money(nano)} to ${name}.`);
        } catch (e) {
            state.textContent = e.status === 402 ? "There isn't enough Balance for that."
                : e.status === 403 ? "You're not an admin of that project."
                    : e.status === 422 ? 'That amount is not valid.'
                        : 'The money could not be moved. Try again in a moment.';
            go.disabled = false;
        }
    }

    // ── Add money ────────────────────────────────────────────
    function openAddMoney() {
        const dialog = $('w-add-dialog');
        const state = $('w-add-state');
        state.textContent = balanceOpen() ? '' : "Balance isn't open yet.";
        $('w-add-amount').value = '';
        $('w-add-go').disabled = !balanceOpen();
        // Only the providers that answer with a hosted checkout are offered here; PowerChat is finished in the
        // product that started the tip, not in a wallet dialog.
        const providers = DATA && DATA.rates && DATA.rates.providers ? DATA.rates.providers : null;
        const labels = { stripe: 'A card (Stripe)', paypal: 'PayPal', ccbill: 'CCBill', nowpayments: 'Crypto (NOWPayments)' };
        const select = $('w-add-provider');
        select.replaceChildren();
        for (const key of Object.keys(labels)) {
            if (providers && providers[key] === false) continue;
            const o = document.createElement('option');
            o.value = key;
            o.textContent = labels[key];
            select.appendChild(o);
        }
        if (!select.options.length) {
            state.textContent = 'No payment provider is open right now.';
            $('w-add-go').disabled = true;
        }
        if (!dialog.open) dialog.showModal();
        setTimeout(() => $('w-add-amount').focus(), 0);
    }

    function updateAdd() {
        const nano = M.dollarsToNano($('w-add-amount').value);
        const go = $('w-add-go');
        if (!nano || BigInt(nano) <= 0n) { go.disabled = true; return; }
        $('w-add-state').textContent = '';
        go.disabled = !balanceOpen();
    }

    async function submitAdd() {
        const nano = M.dollarsToNano($('w-add-amount').value);
        const provider = $('w-add-provider').value;
        const state = $('w-add-state');
        const go = $('w-add-go');
        if (!nano) { state.textContent = 'Enter an amount in dollars, like 20.00.'; return; }
        if (BigInt(nano) % 10000000n !== 0n) { state.textContent = 'Use whole cents, like 20.00 or 20.50.'; return; }
        const cents = BigInt(nano) / 10000000n;
        if (cents > 100000000n) { state.textContent = 'That amount is above the single top-up limit.'; return; }
        go.disabled = true;
        state.textContent = 'Opening the checkout…';
        try {
            const out = await W.api('/api/wallet/topups', { method: 'POST', body: { provider, amount_cents: Number(cents) } });
            const url = out && out.checkout_url ? W.httpsUrl(out.checkout_url) : null;
            if (url) { window.location.assign(url.href); return; }
            state.textContent = 'The checkout did not open. Try again, or add money from OpenVibe.Live.';
            go.disabled = false;
        } catch (e) {
            state.textContent = e.status === 422 ? "That amount isn't offered right now. Try another."
                : e.status === 409 ? 'That payment provider is not open right now.'
                    : e.status === 404 || e.status === 503 ? "Adding money isn't open yet."
                        : 'The checkout could not open. Try again in a moment.';
            go.disabled = false;
        }
    }

    function openVibes() {
        const rates = DATA && DATA.rates ? DATA.rates : null;
        const personal = DATA && DATA.balance && DATA.balance.personal;
        S.openVibes({
            rates,
            bitsPerUsd: DATA && DATA.vibes && DATA.vibes.bits_per_usd ? DATA.vibes.bits_per_usd : (rates && rates.bits_per_usd),
            balanceNano: personal ? String(personal.available_nano_usd) : null,
            canBuy: !!(DATA && DATA.state.vibes === 'open'),
            onDone: () => load(),
        });
    }

    // ── Page ─────────────────────────────────────────────────
    function render() {
        renderCards();
        renderProjects();
        renderActivity();
    }

    async function load() {
        banner('');
        try {
            DATA = await W.api('/api/wallet');
            render();
            renderActions();
        } catch (e) {
            banner("The wallet couldn't load right now.", true);
            $('w-balance-amount').textContent = '—';
            $('w-vibes-amount').textContent = '—';
            $('w-coins-amount').textContent = '—';
        }
    }

    function bind() {
        fillGlyphs();
        // Nothing in a card is actionable until its numbers are here (no spinner: a dimmed button is the wait).
        for (const id of ['w-add-money', 'w-move', 'w-get-vibes']) $(id).disabled = true;
        for (const chip of document.querySelectorAll('.w-chip')) {
            chip.addEventListener('click', () => { filter = chip.dataset.filter; applyFilter(); });
        }
        for (const close of document.querySelectorAll('[data-close]')) {
            close.addEventListener('click', () => { const d = close.closest('dialog'); if (d) d.close(); });
        }
        for (const dialog of document.querySelectorAll('dialog.ovk-sheet')) W.closeOnBackdrop(dialog);
        $('w-transfer-project').addEventListener('change', (e) => { transfer.project = e.target.value; });
        $('w-transfer-amount').addEventListener('input', updateTransfer);
        $('w-transfer-go').addEventListener('click', submitTransfer);
        $('w-add-amount').addEventListener('input', updateAdd);
        $('w-add-go').addEventListener('click', submitAdd);
        $('w-add-money').addEventListener('click', openAddMoney);
        $('w-move').addEventListener('click', () => {
            if (!balanceOpen()) { banner("Your Balance isn't open yet."); return; }
            if (!projects().length) { banner('Create a project on OpenVibe.Services first, then you can move money to it.'); return; }
            openTransfer(null);
        });
        $('w-get-vibes').addEventListener('click', openVibes);
    }

    (async function start() {
        const user = await W.person();
        if (!user) return;
        W.navbar(user);
        bind();
        await load();
    })().catch(() => {
        banner("The wallet couldn't start. Reload the page.", false);
    });
}());
