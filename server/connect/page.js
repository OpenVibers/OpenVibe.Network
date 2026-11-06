'use strict';
/**
 * The Apps page (Compute plan E7): the catalogue, the walkthrough, the connected list, the log.
 *
 * The page is built from the kit's own components (openvibe-shared/kit), phone first: the catalogue is
 * a list of folds (a card that opens), so on a phone one app is one screen and the page is never a
 * long scroll. The walkthrough, the paste box and the test result live inside the fold that opens.
 *
 * The dynamic parts (the test result, the grants, the log, the approvals) are drawn by
 * public/js/connect.js from the Connect API; the page itself is the shell and the catalogue.
 */
const kit = require('openvibe-shared/kit');
const shell = require('openvibe-shared/shell');
const registry = require('./apps');
const vault = require('./vault');
const callers = require('./callers');
const approvals = require('./approvals');

/** The page's own rules: the paste box is wide enough for a token, and the walkthrough reads well. */
const PAGE_CSS = `<style>
.ovk-connect .ovk-fold-body form{margin:0}
.ovk-connect .ovk-field{display:block;margin:0 0 10px}
.ovk-connect .ovk-field span{display:block;font-size:12px;color:var(--ovk-muted,var(--text-secondary));margin:0 0 4px}
.ovk-connect .ovk-field input{width:100%;box-sizing:border-box;min-height:44px;padding:10px 12px;border-radius:10px;border:1px solid var(--ovk-line,var(--border));background:var(--ovk-input,var(--bg-input));color:inherit;font:inherit}
.ovk-connect .ovk-steps{counter-reset:step;list-style:none;margin:0 0 14px;padding:0}
.ovk-connect .ovk-steps li{counter-increment:step;position:relative;padding:0 0 12px 34px;font-size:14px;line-height:1.45}
.ovk-connect .ovk-steps li::before{content:counter(step);position:absolute;left:0;top:0;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;background:var(--ovk-accent-soft,var(--bg-input));color:var(--ovk-accent,var(--accent))}
.ovk-connect .ovk-steps a{display:inline-block;margin-top:4px}
.ovk-connect .ovk-result{margin:12px 0 0;padding:10px 12px;border-radius:10px;font-size:13px;background:var(--ovk-input,var(--bg-input));border:1px solid var(--ovk-line,var(--border));overflow-wrap:anywhere}
.ovk-connect .ovk-result--bad{border-color:#b91c1c;color:#fca5a5}
.ovk-connect .ovk-result--ok{border-color:#15803d;color:#86efac}
.ovk-connect .ovk-grants{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
.ovk-connect .ovk-grants-panel{margin:0 0 18px}
.ovk-connect .ovk-grants-head,.ovk-connect .ovk-grant-row{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--ovk-line,var(--border));font-size:14px}
.ovk-connect .ovk-grants-head{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ovk-muted,var(--text-secondary))}
.ovk-connect .ovk-grant-select{min-height:40px;border-radius:8px;border:1px solid var(--ovk-line,var(--border));background:var(--ovk-input,var(--bg-input));color:inherit;font:inherit;padding:6px 8px}
@media (max-width:480px){
.ovk-connect .ovk-btn{width:100%}
.ovk-connect .ovk-row-trail{width:100%;padding-left:48px;box-sizing:border-box}
}
</style>`;

/** The kit's own muted colour names differ between releases; these are the ones the page uses. */
const esc = kit.esc;

/** The step list of a walkthrough. */
function stepsOf(walkthrough = []) {
    return `<ol class="ovk-steps">${walkthrough.map((s) => `<li><strong>${esc(s.title)}</strong><br>${esc(s.text)}${
        s.link ? `<br><a href="${esc(s.link)}" rel="noopener nofollow" target="_blank">${esc(s.linkLabel || 'Open it')}</a>` : ''
    }</li>`).join('')}</ol>`;
}

/** The paste box, one field per credential the app needs, and the two buttons. */
function connectForm(def) {
    const fields = (def.auth.fields || []).map((f) => `<label class="ovk-field"><span>${esc(f.label)}</span><input type="password" autocomplete="off" spellcheck="false" data-ovk-field="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}"></label>`).join('');
    const byok = def.auth.kind === 'byok_link';
    if (byok) {
        const links = (def.byok && def.byok.providers || []).map((p) => `<p><a href="${esc(p.link)}" rel="noopener nofollow" target="_blank">${esc(p.linkLabel || p.name)}</a> — ${esc(p.hint || '')}</p>`).join('');
        return `<p>${esc((def.byok && def.byok.note) || 'The key lives in OpenVibe.AI.')}</p>${links}`;
    }
    return `<form class="ovk-form" data-ovk-connect="${esc(def.key)}">${fields}
        <p class="ovk-grants">
            ${kit.button({ type: 'button', label: 'Test', icon: 'check', kind: 'quiet', attrs: { 'data-ovk-test': '1' } })}
            ${kit.button({ type: 'button', label: 'Connect', icon: 'plus', kind: 'primary', attrs: { 'data-ovk-save': '1' } })}
        </p>
        <p class="ovk-result" data-ovk-result hidden></p>
    </form>`;
}

/** The catalogue: one fold per app, with the walkthrough and the paste box inside. */
function catalogueHtml(connected) {
    const folds = registry.all().map((def) => {
        const isConnected = connected.has(def.key);
        const body = [
            `<p>${esc(def.blurb)}</p>`,
            `<p class="ovk-note">${esc(def.auth.label)}${(def.auth.scopes || []).length ? ' · ' + esc(def.auth.scopes.join(', ')) : ''}</p>`,
            stepsOf(def.walkthrough),
            connectForm(def),
        ].join('\n');
        return kit.fold({
            id: `app-${def.key}`,
            title: def.name,
            meta: isConnected ? 'connected' : def.auth.kind === 'byok_link' ? 'in OpenVibe.AI' : 'not connected',
            body,
        });
    }).join('\n');
    return `<div class="ovk-connect-grid">${folds}</div>`;
}

/** The connected list: the credentials, the grants per caller, and Revoke. */
function connectedHtml(list, callersList, subject) {
    if (!list.length) {
        return kit.empty({
            title: 'No app is connected yet',
            text: 'Pick an app from the catalogue, paste your own key, and your agents can work in it.',
            icon: 'plus',
            action: { href: '/apps', label: 'Open the catalogue' },
        });
    }
    const rows = list.map((c) => {
        const when = kit.when(c.created_at);
        const grants = callersList.map((call) => {
            const level = (call.grants || {})[c.app];
            if (!level) return '';
            return `<span class="ovk-badge">${esc(call.name)}: ${esc(level)}</span>`;
        }).join(' ');
        const revoke = kit.button({ type: 'button', label: 'Revoke', kind: 'danger', small: true, attrs: { 'data-ovk-revoke': c.app, 'data-ovk-label': c.label } });
        const trail = (grants ? `<div class="ovk-grants">${grants}</div>` : '') + revoke;
        return kit.row({
            mark: kit.mark({ name: c.app, square: true, size: 36 }),
            title: c.app,
            badge: c.scopes && c.scopes.length ? kit.badge(`${c.scopes.length} scopes`) : '',
            meta: when.text,
            metaIso: when.iso,
            sub: [`added ${when.text}`, c.last_used_at ? `last used ${kit.when(c.last_used_at).text}` : 'not used yet', (c.scopes || []).join(', ')].filter(Boolean).join(' · '),
            trail,
            attrs: { 'data-ovk-credential': c.app },
        });
    });
    return kit.list(rows, { title: 'Your credentials', empty: 'No app is connected yet.' });
}

/** The callers: the keys the person made, and the grants each one holds. */
function callersHtml(list) {
    const rows = list.map((c) => {
        const trail = c.kind === 'key' ? kit.button({ type: 'button', label: 'Revoke', kind: 'danger', small: true, attrs: { 'data-ovk-revoke-caller': c.id } }) : '';
        const grants = Object.entries(c.grants || {}).map(([app, level]) => `<span class="ovk-badge">${esc(app)}: ${esc(level)}</span>`).join(' ');
        return kit.row({
            mark: kit.mark({ name: c.name, size: 36 }),
            title: c.name,
            badge: kit.badge(c.kind === 'person' ? 'you' : c.kind === 'key' ? 'your key' : 'a service'),
            sub: [c.token_prefix ? `key …${c.token_prefix}` : '', grants].filter(Boolean).join(' · '),
            trail,
            attrs: { 'data-ovk-caller': c.id },
        });
    });
    const maker = `<form class="ovk-form" data-ovk-make-key><label class="ovk-field"><span>Name this caller</span><input type="text" name="name" maxlength="100" placeholder="Claude Code on my laptop"></label><p>${kit.button({ type: 'submit', label: 'Make a key', icon: 'plus' })}</p><p class="ovk-result" data-ovk-key hidden></p></form>`;
    return kit.list(rows, { title: 'Callers', empty: 'No callers yet.' }) + kit.section({ title: 'Make a key', note: 'For a caller of your own — your Claude Code, a script on your laptop. The key is shown once.', body: maker });
}

/** The log: what was done, by whom, and whether it worked. */
function logHtml(rows) {
    if (!rows.length) {
        return kit.empty({ title: 'Nothing yet', text: 'Every call your agents make in your apps is written here.', icon: 'chat' });
    }
    const body = rows.map((r) => kit.row({
        mark: kit.mark({ name: r.app, square: true, size: 32 }),
        title: r.action,
        badge: r.ok ? kit.badge('ok', 'ok') : kit.badge('failed', 'bad'),
        meta: kit.when(r.created_at).text,
        metaIso: kit.when(r.created_at).iso,
        sub: [r.caller_name || r.caller_id, r.risk, r.ok ? '' : (r.error_code || 'failed')].filter(Boolean).join(' · '),
    })).join('');
    return kit.list(body, { title: 'The log', empty: 'Nothing yet.' });
}

/** The whole page. */
async function renderPage(ctx, user) {
    const subject = user ? (user.subject_id || String(user.id)) : null;
    const tab = kit.tabOf(ctx.query || {}, ['catalogue', 'connected', 'log']);

    let body;
    let headHtml = '';
    if (!user) {
        body = kit.empty({
            title: 'Sign in to connect your apps',
            text: 'Your agents work in your own apps with your own keys. Sign in to connect them.',
            action: { href: '/login?next=%2Fapps', label: 'Sign in' },
        });
    } else {
        const list = await vault.list(ctx.db, subject);
        const connected = new Set(list.map((c) => c.app));
        const callersList = await callers.listCallers(ctx.db, subject);
        const pending = (await approvals.list(ctx.db, subject, { state: 'pending' })).filter((a) => a.expires_at > new Date().toISOString());

        const needsYou = pending.length ? kit.section({
            title: 'Needs you',
            count: pending.length,
            note: 'A send, a delete or a pay action waits for you before it happens.',
            body: kit.list(pending.map((a) => kit.row({
                mark: kit.mark({ name: a.app, square: true, size: 36 }),
                title: a.summary || a.action,
                sub: `${a.action} · asked ${kit.when(a.created_at).text}`,
                trail: [
                    kit.button({ type: 'button', label: 'Allow', kind: 'primary', small: true, attrs: { 'data-ovk-approval': a.id, 'data-ovk-decision': 'approve' } }),
                    kit.button({ type: 'button', label: 'Deny', kind: 'quiet', small: true, attrs: { 'data-ovk-approval': a.id, 'data-ovk-decision': 'deny' } }),
                ].join(''),
            }))),
            id: 'ovk-needs-you',
        }) : '';

        const tabs = kit.tabs({
            base: '/apps',
            items: [
                { key: 'catalogue', label: 'Catalogue' },
                { key: 'connected', label: 'Connected', count: list.length || '' },
                { key: 'log', label: 'Log' },
            ],
            active: tab,
        });

        if (tab === 'connected') {
            body = needsYou + connectedHtml(list, callersList, subject) + kit.section({ title: 'Who may do what', note: 'Each caller of yours, in each app: nothing, read, or read and write.', body: '<div class="ovk-grants-panel" data-ovk-grants-panel></div>' }) + callersHtml(callersList);
        } else if (tab === 'log') {
            const rows = await ctx.gateway.listLog({ subject, limit: 100 });
            body = needsYou + logHtml(rows);
        } else {
            body = needsYou + kit.find({ action: '/apps', name: 'q', placeholder: 'Search the apps', label: 'Search the apps' }) + catalogueHtml(connected);
        }

        headHtml = kit.head({
            title: 'Apps',
            sub: 'Your agents, in your other apps, with your own keys.',
            tabs,
        });
    }

    const canonical = String(ctx.config.baseUrl || 'https://openvibe.network').replace(/\/+$/, '') + '/apps';
    return shell.page({
        name: 'network',
        service: 'network',
        title: 'Apps',
        siteName: 'OpenVibe.Network',
        description: 'Connect your own apps: your agents work in them with your own keys.',
        canonical,
        robots: 'noindex, nofollow',
        head: '<link rel="stylesheet" href="/shared/kit.css">\n<script src="/shared/kit-web.js" defer></script>\n<script src="/js/connect.js" defer></script>\n' + PAGE_CSS,
        body: '<main class="ovk-page ovk-connect">\n' + (headHtml || '') + body + '</main>',
        navLinks: [{ label: 'Your account', href: '/my' }],
        navbar: { service: 'network' },
        footer: { service: 'network', variant: 'compact' },
    });
}

/** The route: GET /apps (and the root of connect.openvibe.network). */
function createAppsPage(ctx) {
    return async function appsPage(req, res) {
        try {
            const token = require('../auth/session').requestToken(req);
            let user = null;
            if (token) {
                const out = await require('../auth/session').verifySession(token, ctx.authCtx);
                if (!out.error) user = out.user;
            }
            const html = await renderPage({ ...ctx, query: req.query }, user);
            res.set('Cache-Control', 'private, no-store');
            res.set('X-Robots-Tag', 'noindex, nofollow');
            res.type('html').send(html);
        } catch (err) {
            console.error('[Connect] the Apps page failed:', err.message);
            res.status(500).type('html').send('<!doctype html><title>Apps</title><p>Something went wrong.');
        }
    };
}

module.exports = { createAppsPage, renderPage };
