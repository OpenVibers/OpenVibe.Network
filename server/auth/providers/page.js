'use strict';
/**
 * The sign-in page's provider buttons, rendered on the server (plan §AB.20). The page has to be indexable: a crawler
 * does not run login.js, so the sentence a search engine reads ("Sign in to OpenVibe with Google, Discord, Twitch …")
 * and one link per switched-on provider are in the HTML as it leaves the server, not added by script.
 *
 * Only providers the owner has set up are drawn (config.isEnabled): a button that leads to "not configured" is worse
 * than no button. When none is, the section is left out and the page reads as it did before.
 *
 *   const { html, providers } = await signInPage({ db, baseUrl, file })
 */
const fs = require('fs');
const path = require('path');
const configNs = require('./config');

const LOGIN = path.join(__dirname, '..', '..', '..', 'public', 'login.html');
const MARK = '<!--OV:SIGNIN-PROVIDERS-->';
let cache = { mtimeMs: -1, source: '' };

function source(file = LOGIN) {
    const { mtimeMs } = fs.statSync(file);
    if (cache.mtimeMs !== mtimeMs || cache.file !== file) cache = { mtimeMs, file, source: fs.readFileSync(file, 'utf8') };
    return cache.source;
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "Google, Discord and Twitch": a list a person and a crawler both read as one sentence. */
function listNames(names) {
    if (names.length <= 1) return names[0] || '';
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The glyph for one provider: Shared's brand mark where it exists, the preset's generic icon otherwise. */
function glyph(p, config) {
    if (config.icon && config.icon.brand) return `<i data-ov-brand="${esc(config.icon.brand)}" aria-hidden="true"></i>`;
    const name = (config.icon && config.icon.icon) || 'globe';
    return `<i data-ov-icon="${esc(name)}" aria-hidden="true"></i>`;
}

function section(providers) {
    if (!providers.length) return '';
    const names = providers.map((p) => p.name);
    const links = providers.map((p) => `<a class="provider-btn" href="/api/auth/connect/${encodeURIComponent(p.id)}" data-provider="${esc(p.id)}" rel="nofollow">`
        + `${glyph(p, p)}<span>Sign in with ${esc(p.name)}</span></a>`).join('');
    return `<section class="providers" id="signin-providers" aria-labelledby="providers-head">`
        + `<h2 class="providers-head" id="providers-head">Sign in to OpenVibe with ${esc(listNames(names))}</h2>`
        + `<div class="provider-list">${links}</div>`
        + `<p class="providers-note">A first sign-in makes a new OpenVibe account; a provider already linked signs you straight in.</p>`
        + `</section>`;
}

/** Replace the head's description and the card's provider marker; leave everything else exactly as the file wrote it. */
function render(src, providers) {
    const names = providers.map((p) => p.name);
    const description = names.length
        ? `Sign in to OpenVibe with ${listNames(names)} — one account across OpenVibe.Live, OpenVibe.Tools, OpenVibe.Games and OpenVibe.Media.`
        : null;
    let html = src;
    if (description) {
        html = html.replace(/(<meta name="description" content=")[^"]*(">)/, `$1${esc(description)}$2`)
            .replace(/(<meta property="og:description" content=")[^"]*(">)/, `$1${esc(description)}$2`);
    }
    if (!html.includes(MARK)) return html;      // an older page: the server-side buttons are simply not there
    return html.replace(MARK, () => section(providers));
}

/** The page as it goes out, with the providers this Network offers today. */
async function signInPage({ db, baseUrl, file = LOGIN, providers: wanted = true } = {}) {
    let providers = [];
    if (wanted) {
        try {
            const store = await configNs.forDb(db, baseUrl);
            const all = await store.get();
            providers = (all && all.signin_switch === false) ? [] : configNs.enabledProviders(store);
        } catch { /* a fresh database without the namespace: no buttons, the page still works */ }
    }
    return { html: render(source(file), providers), providers };
}

module.exports = { signInPage, render, section, listNames, MARK };
