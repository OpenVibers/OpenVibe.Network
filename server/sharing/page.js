'use strict';
/**
 * openvibe.network/shared — "Shared with me" (design 2026-11-06, SHARING-DESIGN-2026-11-06.md).
 *
 * One list of everything other people have shared with this person, on every site: the site, the
 * item and its link, who shared it, when, and the role. The transfers that wait for an answer come
 * first, with Accept and Decline links to the item itself, where the share sheet asks.
 *
 * The page is built from the kit's own components (openvibe-shared/kit). The one rule of its own is for
 * a phone, where the kit's row would cut the item's name and the words under it: the row wraps there
 * (PAGE_CSS below). Signed out the page says so and offers the sign-in; signed in it never shows
 * anybody else's list.
 */
const kit = require('openvibe-shared/kit');
const shell = require('openvibe-shared/shell');
const store = require('./store');
const { describeItems, itemView, transferView, MAX_DETAILS } = require('./routes');
const { sessionToken, verifySession } = require('../auth/session');

/**
 * The page's own rules, and only for a phone.
 *
 * The kit's row is built for one line: the title and the words under it are cut with an ellipsis,
 * and the trail (Accept and Decline) sits beside them. On a phone there is no room for that, so the
 * row wraps: the title and the words take two lines each, and the two answers go on their own line
 * under the words, where a thumb can reach them.
 *
 * Scoped to this page (.ovk-shared) and to 480 px, so a computer keeps the kit's own look.
 */
const PAGE_CSS = `<style>
@media (max-width:480px){
.ovk-shared .ovk-row--static{flex-wrap:wrap}
.ovk-shared .ovk-row-trail{width:100%;box-sizing:border-box;padding-left:48px}
.ovk-shared .ovk-row-top{align-items:flex-start}
.ovk-shared .ovk-row-top strong{white-space:normal;overflow:visible;text-overflow:clip}
.ovk-shared .ovk-row-sub>span:first-child{white-space:normal;overflow:visible}
}
</style>`;

/** What the item is called when the owning service does not name it. */
function fallbackName(item) {
    const kind = String(item.kind || 'item').replace(/[_-]+/g, ' ');
    return 'a ' + kind + (item.site ? ' on ' + (item.site.full_name || item.site.name) : '');
}

/** "@goosely" for a person. */
function labelOf(person) {
    return person && person.username ? '@' + person.username : 'Someone';
}

/** The name a person's picture is drawn from. */
function nameOf(person) {
    if (!person) return '?';
    return person.display_name || person.username || '?';
}

/** The page: the list, the transfers, and the empty states. */
async function renderPage(ctx, user) {
    const subject = user ? user.subject_id : null;
    let items = [];
    let transfers = [];
    if (subject) {
        const grants = await store.listGrants(ctx.db, subject);
        const pending = (await store.listTransfers(ctx.db, subject)).filter((t) => t.state === 'pending');
        const refs = [
            ...grants.map((g) => ({ service: g.service, kind: g.kind, id: g.item_id })),
            ...pending.map((t) => ({ service: t.service, kind: t.kind, id: t.item_id })),
        ].slice(0, MAX_DETAILS);
        const details = await describeItems(ctx, refs, user);
        const owners = new Map();
        const ownerOf = async (s) => {
            if (!store.isSubject(s)) return null;
            if (!owners.has(s)) owners.set(s, await store.personBySubject(ctx.db, s));
            return owners.get(s);
        };
        for (const g of grants) {
            items.push(itemView(g, await ownerOf(g.owner_subject), details.get([g.service, g.kind, g.item_id].join('|'))));
        }
        for (const t of pending) {
            transfers.push(transferView(t, await ownerOf(t.from_subject), details.get([t.service, t.kind, t.item_id].join('|'))));
        }
    }

    const transferRows = transfers.map((t) => {
        const when = kit.when(t.requested_at);
        // The two answers sit in the row's trail, and the row's own line keeps the item's name: on
        // a phone the trail takes the room a badge or a date would.
        const trail = [
            t.accept_url ? kit.button({ href: t.accept_url, label: 'Accept', kind: 'primary', small: true }) : '',
            t.decline_url ? kit.button({ href: t.decline_url, label: 'Decline', kind: 'quiet', small: true }) : '',
        ].filter(Boolean).join('');
        const site = t.site ? (t.site.full_name || t.site.name) : '';
        return kit.row({
            mark: kit.mark({ name: nameOf(t.from), src: t.from ? t.from.avatar_url : null, size: 36 }),
            title: t.title || fallbackName(t),
            sub: [labelOf(t.from) + ' wants to give you this', site, when.text].filter(Boolean).join(' \u00b7 '),
            trail,
        });
    });

    const itemRows = items.map((i) => {
        const when = kit.when(i.shared_at);
        return kit.row({
            href: i.url || null,
            mark: kit.mark({ name: nameOf(i.owner), src: i.owner ? i.owner.avatar_url : null, size: 36 }),
            title: i.title || fallbackName(i),
            badge: kit.badge(i.role === 'editor' ? 'Can edit' : 'Can view', i.role === 'editor' ? 'accent' : ''),
            meta: when.text,
            metaIso: when.iso,
            sub: 'shared by ' + labelOf(i.owner) + ' \u00b7 ' + (i.site ? (i.site.full_name || i.site.name) : ''),
        });
    });

    const stats = kit.stats([
        [items.length, 'shared with you'],
        [transfers.length, 'waiting for you'],
    ], { label: 'What is shared with you' });

    let body;
    if (!user) {
        body = kit.empty({
            title: 'Sign in to see what is shared with you',
            text: 'Everything other people share with you lives here, on every site.',
            action: { href: '/login?next=%2Fshared', label: 'Sign in' },
        });
    } else if (!items.length && !transfers.length) {
        body = kit.empty({
            title: 'Nothing is shared with you yet',
            text: 'When someone shares a paste, a picture or a project with you, it lands here.',
            icon: 'check',
        });
    } else {
        body = [
            transfers.length ? kit.section({
                title: 'Waiting for you',
                count: transfers.length,
                note: 'Open the item to look before you answer.',
                body: kit.list(transferRows),
            }) : '',
            items.length ? kit.section({
                title: 'Shared with you',
                count: items.length,
                body: kit.list(itemRows),
            }) : '',
        ].join('\n');
    }

    return shell.page({
        name: 'network',
        service: 'network',
        title: 'Shared with me',
        siteName: 'OpenVibe.Network',
        description: 'Everything other people have shared with you on OpenVibe, in one place.',
        canonical: String(ctx.config.baseUrl || 'https://openvibe.network').replace(/\/+$/, '') + '/shared',
        robots: 'noindex, nofollow',
        head: '<link rel="stylesheet" href="/shared/kit.css">\n<script src="/shared/kit-web.js" defer></script>\n' + PAGE_CSS,
        body: '<main class="ovk-page ovk-shared">\n'
            + kit.head({ title: 'Shared with me', sub: 'What other people have shared with you.' })
            + (user ? stats : '')
            + body
            + '</main>',
        navLinks: [{ label: 'Your account', href: '/my' }],
        navbar: { service: 'network' },
        footer: { service: 'network', variant: 'compact' },
    });
}

/**
 * The route: GET /shared.
 * @param {object} ctx  { db, config, privateKey, issuer, fetchImpl, serviceBase, authCtx }
 */
function createSharedPage(ctx) {
    return async function sharedPage(req, res) {
        try {
            const token = sessionToken(req);
            let user = null;
            if (token) {
                const out = await verifySession(token, ctx.authCtx);
                if (!out.error) user = out.user;
            }
            const html = await renderPage(ctx, user);
            res.set('Cache-Control', 'private, no-store');
            res.set('X-Robots-Tag', 'noindex, nofollow');
            res.type('html').send(html);
        } catch (err) {
            console.error('[Sharing] GET /shared error:', err.message);
            res.status(500).type('html').send('<!doctype html><title>Shared with me</title><p>Something went wrong.');
        }
    };
}

module.exports = { createSharedPage, renderPage };
