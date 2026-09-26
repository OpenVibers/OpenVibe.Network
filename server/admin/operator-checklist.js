'use strict';
/**
 * Operator parity checklist (roadmap WS-D task 5): every operator job the old single-site admin did,
 * and where it is done now. Each item names its places, one of:
 *
 *   tab   a tab of this admin page (admin.html showTab id)
 *   url   another service's console (answered, not 404, when last checked)
 *   api   an API with no console yet (a gap the checklist shows, not hides)
 *   cli   the host operator CLI (ovhost) on the server
 *
 * `service` ties an item to a registry id so the page can show that service's readiness next to it.
 * GET /api/admin/operator-checklist returns the list with each service's last observed status.
 * test/operator-checklist.test.js checks every tab exists and every url is an OpenVibe https origin;
 * scripts/operator-checklist-check.js probes the urls live.
 */
const AREAS = [
    { area: 'People', items: [
        { item: 'Users: find, view, change', where: [{ kind: 'tab', tab: 'users' }], service: 'network' },
        { item: 'Roles and staff', where: [{ kind: 'tab', tab: 'moderators' }, { kind: 'tab', tab: 'grants', note: 'service principals (owner)' }], service: 'network' },
        { item: 'Bans (accounts, IPs, networks)', where: [{ kind: 'tab', tab: 'bans' }, { kind: 'url', url: 'https://openvibe.live/admin', note: 'Live bans and IP ranges' }], service: 'network' },
        { item: 'Search across the network', where: [{ kind: 'url', url: 'https://search.openvibe.network/' }], service: 'search' },
    ] },
    { area: 'Site', items: [
        { item: 'Site settings (revisioned, with rollback)', where: [{ kind: 'tab', tab: 'settings' }, { kind: 'url', url: 'https://openvibe.live/admin', note: 'Live settings' }], service: 'network' },
        { item: 'Email configuration and a test send', where: [{ kind: 'tab', tab: 'email' }], service: 'network' },
        { item: 'Announcements and notifications', where: [{ kind: 'tab', tab: 'notifications' }], service: 'network' },
        { item: 'Theme review', where: [{ kind: 'tab', tab: 'themes' }], service: 'network' },
    ] },
    { area: 'Health, storage and media', items: [
        { item: 'Service health (readiness of every service)', where: [{ kind: 'url', url: 'https://openvibe.network/status' }], service: 'network' },
        { item: 'Storage', where: [{ kind: 'tab', tab: 'storage' }], service: 'media' },
        { item: 'Media operations (jobs, tiers, repairs)', where: [{ kind: 'api', api: 'OpenVibe.Media /api/v1/jobs, /internal/*', note: 'no console yet' }, { kind: 'cli', cli: 'node scripts/h15-repair.js, object-drift-report.js (Media)' }], service: 'media' },
    ] },
    { area: 'Queues', items: [
        { item: 'Events: subscriptions, dead letters, replay', where: [{ kind: 'tab', tab: 'eventsops' }, { kind: 'url', url: 'https://events.openvibe.network/' }], service: 'events' },
        { item: 'AI runs, providers and routes', where: [{ kind: 'url', url: 'https://ai.openvibe.network/' }, { kind: 'tab', tab: 'ai' }], service: 'ai' },
    ] },
    { area: 'Moderation, money and loyalty', items: [
        { item: 'Moderation audit across services', where: [{ kind: 'tab', tab: 'modlog' }], service: 'network' },
        { item: 'Chat logs and chat moderation', where: [{ kind: 'tab', tab: 'chat-logs' }], service: 'chat' },
        { item: 'Community moderation', where: [{ kind: 'api', api: 'OpenVibe.Community staff routes', note: 'no console yet' }], service: 'community' },
        { item: 'Payments, cashouts and the money freeze', where: [{ kind: 'url', url: 'https://billing.openvibe.network/', note: 'Billing console' }, { kind: 'tab', tab: 'cashouts' }, { kind: 'tab', tab: 'payments' }], service: 'billing' },
        { item: 'Loyalty (OpenCoins, channel points)', where: [{ kind: 'api', api: 'live.loyalty user module; Network /internal/coins/*', note: 'summaries only; loyalty is never money' }], service: 'network' },
        { item: 'Developer apps and trust (Codes)', where: [{ kind: 'url', url: 'https://openvibe.codes/staff' }], service: 'codes' },
    ] },
    { area: 'Releases and readiness', items: [
        { item: 'Migration and readiness', where: [{ kind: 'url', url: 'https://openvibe.network/status' }, { kind: 'cli', cli: 'ovhost status, ovhost validate <service>' }], service: 'host' },
        { item: 'Compatibility status (contracts, pins, the register)', where: [{ kind: 'url', url: 'https://openvibe.codes/docs' }, { kind: 'cli', cli: 'ovhost validate <service> (contracts range)' }], service: 'codes' },
        { item: 'Deploys', where: [{ kind: 'tab', tab: 'deploy' }, { kind: 'cli', cli: 'ovhost deploy <service>' }], service: 'host' },
        { item: 'Domains and certificates', where: [{ kind: 'tab', tab: 'domains' }, { kind: 'cli', cli: 'ovhost certs' }], service: 'host' },
    ] },
];

/** The checklist with each service's last observed readiness (from the status rows, if given). */
function checklist(statusRows = []) {
    const byId = new Map((statusRows || []).map((r) => [r.id || r.service, r]));
    return AREAS.map((a) => ({
        area: a.area,
        items: a.items.map((it) => {
            const st = it.service ? byId.get(it.service) : null;
            const hasConsole = it.where.some((w) => w.kind === 'tab' || w.kind === 'url');
            return { ...it, console: hasConsole, status: st ? (st.status || (st.runtime && st.runtime.status) || 'unknown') : 'unknown' };
        }),
    }));
}

function router({ statusRows = () => [] } = {}) {
    const express = require('express');
    const r = express.Router();
    r.get('/', (req, res) => {
        let rows = [];
        try { rows = statusRows() || []; } catch { rows = []; }
        res.set('Cache-Control', 'private, no-store').json({ areas: checklist(rows) });
    });
    return r;
}

module.exports = { AREAS, checklist, router };
