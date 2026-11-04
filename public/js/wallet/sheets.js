/* openvibe.network/wallet — the Get Vibes sheet, shared by /wallet and /pay/:id.
 *
 * Two tabs, one sheet: "With a card" is the existing packs flow (OpenVibe.Live's Buy Vibes window, which starts a
 * Billing intent and credits the Vibes here), and "With your Balance" buys Vibes from the person's Balance at the
 * same pack value rate, with the exact dollar cost shown before the confirm. No card form lives here; the card tab
 * hands off to the flow that already owns cards. Nothing spins: a static "Getting…" is the whole busy state.
 */
(function (root) {
    'use strict';

    const W = root.OVWallet;
    const M = root.OVWalletMoney;
    if (!W || !M) return;

    const LIVE_VIBES = 'https://openvibe.live/#vibes';
    let sheet = null;
    let ctx = null;

    function dollarsCents(cents) {
        const c = Math.max(0, Math.trunc(Number(cents) || 0));
        return `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
    }

    function randomKey() {
        try { if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID(); } catch { /* older browser */ }
        return `wallet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }

    function build() {
        if (sheet) return sheet;
        sheet = W.el('dialog', 'ovk-sheet w-sheet w-vibes-sheet');
        sheet.id = 'w-vibes-sheet';
        sheet.setAttribute('aria-labelledby', 'w-vibes-h');
        sheet.innerHTML = `
            <div class="ovk-sheet-head">
                <h2 id="w-vibes-h">Get Vibes</h2>
                <button type="button" class="ovk-icon-btn" data-close aria-label="Close" title="Close">×</button>
            </div>
            <div class="ovk-sheet-body">
                <p class="w-sheet-lede">For tips, cheers and fun stuff. Bought in whole Vibes, never earned.</p>
                <div class="w-tabs" role="tablist" aria-label="How to get Vibes">
                    <button type="button" role="tab" class="w-tab" id="w-tab-card" aria-selected="true" aria-controls="w-panel-card" tabindex="0">With a card</button>
                    <button type="button" role="tab" class="w-tab" id="w-tab-balance" aria-selected="false" aria-controls="w-panel-balance" tabindex="-1">With your Balance</button>
                </div>
                <section id="w-panel-card" role="tabpanel" aria-labelledby="w-tab-card">
                    <p class="w-sheet-note">Packs with a card are bought on <b>OpenVibe.Live</b>. Your Vibes land in this wallet, ready for any site.</p>
                    <div class="w-packs" id="w-packs"></div>
                    <a class="ovk-btn ovk-btn--primary w-sheet-go" id="w-card-go" href="${LIVE_VIBES}" target="_blank" rel="noopener">Open the packs</a>
                </section>
                <section id="w-panel-balance" role="tabpanel" aria-labelledby="w-tab-balance" hidden>
                    <label class="w-field" for="w-vibes-input"><span>Vibes</span>
                        <input id="w-vibes-input" type="number" inputmode="numeric" min="100" step="1" placeholder="1,000" autocomplete="off">
                    </label>
                    <p class="w-cost-line">Costs <b id="w-vibes-cost">—</b> from your Balance</p>
                    <p class="w-sheet-note" id="w-vibes-have"></p>
                    <button type="button" class="ovk-btn ovk-btn--primary w-sheet-go" id="w-vibes-buy" disabled>Get Vibes</button>
                    <p class="w-sheet-note" id="w-vibes-state" role="status" aria-live="polite"></p>
                </section>
                <button type="button" class="w-quiet w-sheet-cancel" data-close>Cancel</button>
            </div>`;
        document.body.appendChild(sheet);
        W.closeOnBackdrop(sheet);
        sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => sheet.close()));

        const tabs = [sheet.querySelector('#w-tab-card'), sheet.querySelector('#w-tab-balance')];
        const panels = { card: sheet.querySelector('#w-panel-card'), balance: sheet.querySelector('#w-panel-balance') };
        function select(which) {
            for (const t of tabs) {
                const on = t.id === `w-tab-${which}`;
                t.setAttribute('aria-selected', String(on));
                t.tabIndex = on ? 0 : -1;
            }
            panels.card.hidden = which !== 'card';
            panels.balance.hidden = which !== 'balance';
            if (which === 'balance') setTimeout(() => sheet.querySelector('#w-vibes-input').focus(), 0);
        }
        tabs.forEach((t) => {
            t.addEventListener('click', () => select(t.id.replace('w-tab-', '')));
            t.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                const which = t.id === 'w-tab-card' ? 'balance' : 'card';
                select(which);
                tabs[which === 'card' ? 0 : 1].focus();
            });
        });

        sheet.querySelector('#w-vibes-input').addEventListener('input', preview);
        sheet.querySelector('#w-vibes-buy').addEventListener('click', buy);
        return sheet;
    }

    function cost() {
        const input = sheet.querySelector('#w-vibes-input');
        const n = M.whole(input.value);
        const rate = ctx && ctx.bitsPerUsd;
        if (!n || !rate) return null;
        const nano = M.priceNano(n, rate);
        return nano ? { vibes: n, nano } : null;
    }

    function preview() {
        const buyBtn = sheet.querySelector('#w-vibes-buy');
        const state = sheet.querySelector('#w-vibes-state');
        const costEl = sheet.querySelector('#w-vibes-cost');
        const have = sheet.querySelector('#w-vibes-have');
        const c = cost();
        if (!c) {
            costEl.textContent = '—';
            buyBtn.disabled = true;
            buyBtn.textContent = 'Get Vibes';
            have.textContent = ctx && ctx.balanceNano != null ? `You have ${M.money(ctx.balanceNano)} in Balance.` : '';
            return;
        }
        costEl.textContent = M.money(c.nano);
        buyBtn.textContent = `Get ${M.vibes(c.vibes)} Vibes`;
        const short = ctx.balanceNano != null && BigInt(ctx.balanceNano) < BigInt(c.nano);
        buyBtn.disabled = !!short || !ctx.canBuy || state.dataset.busy === '1';
        buyBtn.title = short ? 'Not enough Balance' : '';
        if (ctx.balanceNano != null) have.textContent = short
            ? `You need ${M.money(BigInt(c.nano) - BigInt(ctx.balanceNano))} more Balance.`
            : `You have ${M.money(ctx.balanceNano)} in Balance.`;
        else have.textContent = '';
    }

    async function buy() {
        const c = cost();
        const state = sheet.querySelector('#w-vibes-state');
        const buyBtn = sheet.querySelector('#w-vibes-buy');
        if (!c || buyBtn.disabled) return;
        state.dataset.busy = '1';
        state.textContent = 'Getting…';
        buyBtn.disabled = true;
        try {
            const out = await W.api('/api/wallet/vibes/from-balance', { method: 'POST', body: { vibes: c.vibes, idempotency_key: randomKey() } });
            const credit = out && Number.isFinite(Number(out.vibes_credit)) ? Number(out.vibes_credit) : null;
            if (credit != null && ctx) ctx.balanceNano = null;
            state.textContent = `${M.vibes(c.vibes)} Vibes added to your wallet.`;
            if (ctx && typeof ctx.onDone === 'function') {
                try { await ctx.onDone(out); } catch { /* the next visit to the sheet still shows the new number */ }
            }
            sheet.querySelector('#w-vibes-input').value = '';
            preview();
        } catch (e) {
            state.textContent = e.status === 402 ? 'Not enough Balance for that many Vibes.'
                : e.status === 404 ? 'Getting Vibes with Balance is not open yet.'
                    : e.status === 422 ? 'That amount is not offered right now.'
                        : 'The Vibes could not be added. Try again in a moment.';
        } finally {
            state.dataset.busy = '0';
            buyBtn.disabled = false;
            preview();
        }
    }

    function renderPacks(rates) {
        const box = sheet.querySelector('#w-packs');
        box.replaceChildren();
        const packs = rates && Array.isArray(rates.packages) ? rates.packages : [];
        for (const p of packs) {
            const a = W.el('a', 'w-pack');
            a.href = LIVE_VIBES;
            a.target = '_blank';
            a.rel = 'noopener';
            a.append(W.el('b', null, `${M.vibes(p.bits)} Vibes`), W.el('small', null, dollarsCents(p.price_cents)));
            box.appendChild(a);
        }
        const min = rates && rates.min_purchase_bits;
        const input = sheet.querySelector('#w-vibes-input');
        if (min) input.min = String(min);
        if (min) input.placeholder = M.vibes(min);
    }

    /**
     * Open the sheet.
     *   { bitsPerUsd, minPurchaseBits, packages, balanceNano, canBuy, onDone(result), onAddMoney() }
     */
    async function open(options = {}) {
        build();
        const rates = options.rates || null;
        ctx = {
            bitsPerUsd: Number(options.bitsPerUsd || (rates && rates.bits_per_usd) || 100),
            balanceNano: options.balanceNano == null ? null : String(options.balanceNano),
            canBuy: options.canBuy !== false,
            onDone: options.onDone,
            onAddMoney: options.onAddMoney,
        };
        renderPacks(rates);
        const costEl = sheet.querySelector('#w-vibes-cost');
        const state = sheet.querySelector('#w-vibes-state');
        costEl.textContent = '—';
        state.textContent = options.canBuy === false ? 'Getting Vibes with Balance is not open yet.' : '';
        sheet.querySelector('#w-vibes-input').value = '';
        preview();
        // The first tab is the card flow, as in the design; the balance tab keeps the exact price live once chosen.
        sheet.querySelector('#w-tab-card').click();
        if (!sheet.open) sheet.showModal();
    }

    root.OVWalletSheets = { openVibes: open, close() { if (sheet && sheet.open) sheet.close(); } };
}(window));
