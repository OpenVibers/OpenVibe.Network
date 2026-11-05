/* openvibe.network/wallet — money formatting and exact conversion in the browser.
 *
 * Money is integer end to end (MONEY.md): Balance is nano-USD, never a float; Vibes are whole numbers. This module is
 * the only place the page turns those integers into words, and it never uses floating-point arithmetic for them.
 *
 *   OVWalletMoney.money(nano)                 "12340000000" → "$12.40"
 *   OVWalletMoney.signedMoney(nano)           "-4200000" → { text: "$0.0042", sign: "−" }
 *   OVWalletMoney.dollarsToNano("12.40")      → "12400000000" (null when not a valid dollar amount)
 *   OVWalletMoney.priceNano(vibes, perUsd)    → "250000000" (the exact cost, rounded up to the nano)
 *   OVWalletMoney.vibes(1250)                 → "1,250"
 * Usable in the page (window.OVWalletMoney) and in Node's tests (module.exports).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.OVWalletMoney = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const NANO = 1000000000n;

    /** Whole number with thousands separators, or "—" when it is not one. */
    function vibes(n) {
        const v = Number(n);
        return Number.isSafeInteger(v) ? v.toLocaleString('en-US') : '—';
    }

    function group(whole) {
        return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /** Nano-USD as dollars: always at least two decimals, up to nine when the amount is finer than a cent. */
    function money(nano) {
        let n;
        try { n = BigInt(String(nano == null ? 0 : nano)); } catch { return '—'; }
        const neg = n < 0n;
        if (neg) n = -n;
        const whole = n / NANO;
        const frac = String(n % NANO).padStart(9, '0').replace(/0+$/, '');
        const cents = frac.length < 2 ? (frac + '00').slice(0, 2) : frac;
        return `${neg ? '−' : ''}$${group(whole)}.${cents}`;
    }

    /** For an activity row: the unsigned text and the sign, so the page can paint + green and − in the text colour. */
    function signedMoney(nano) {
        let n;
        try { n = BigInt(String(nano == null ? 0 : nano)); } catch { return { sign: '', text: '—' }; }
        if (n === 0n) return { sign: '', text: money(0) };
        return { sign: n < 0n ? '−' : '+', text: money(n < 0n ? -n : n) };
    }

    /** "$12.40" or "12.4" → the exact integer nano-USD, or null. Never parseFloat. */
    function dollarsToNano(raw) {
        const s = String(raw == null ? '' : raw).trim().replace(/^\$/, '').replace(/,/g, '');
        const m = /^(\d{0,15})(?:\.(\d{0,9}))?$/.exec(s);
        if (!m || (m[1] === '' && (m[2] === '' || m[2] === undefined))) return null;
        const whole = m[1] || '0';
        const frac = (m[2] || '').padEnd(9, '0');
        const out = BigInt(whole) * NANO + BigInt(frac || '0');
        return out.toString();
    }

    /** The exact dollar cost of whole Vibes at a whole bits-per-USD rate: ceil(vibes × 1e9 / rate) nano-USD. */
    function priceNano(vibesCount, bitsPerUsd) {
        const v = BigInt(Math.trunc(Number(vibesCount) || 0));
        let rate;
        try { rate = BigInt(Math.trunc(Number(bitsPerUsd) || 0)); } catch { return null; }
        if (v <= 0n || rate <= 0n) return null;
        return (((v * NANO) + rate - 1n) / rate).toString();
    }

    /** A whole amount a person typed: 1,250 → 1250; anything else null. */
    function whole(raw) {
        const s = String(raw == null ? '' : raw).trim().replace(/,/g, '');
        if (!/^\d{1,12}$/.test(s)) return null;
        const n = Number(s);
        return Number.isSafeInteger(n) && n > 0 ? n : null;
    }

    return { money, signedMoney, dollarsToNano, priceNano, whole, vibes };
}));
