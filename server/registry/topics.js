'use strict';
/**
 * Event topics for the ecosystem registry (GET /api/v1/registry/topics).
 *
 * A topic is an event type (`live.stream.started`). The list is built from the openvibe-contracts
 * service manifests (eventsProduced / eventsConsumed) and the event payload contracts
 * (contracts/events/payloads/<type>.v<N>.json), plus two things Network itself knows:
 *
 *   OBSERVED   types a service publishes today that its manifest (openvibe-contracts 0.30.1) does not
 *              list yet. Live and Media declare no eventsProduced there, although both relay these
 *              through their outboxes to OpenVibe.Events. Each row names the code that emits it, so
 *              the row can be deleted once the manifest lists the type.
 *   Network's own consumer  the topics server/notifications/events-consumer.js subscribes to (its
 *              TOPICS), so the registry cannot disagree with what Network actually consumes.
 *
 * Consumer patterns use OpenVibe.Events' syntax: `*` stands for one or more whole segments
 * (`*.index_document.upserted`). A pattern is listed on every topic it matches.
 */
const contracts = require('openvibe-contracts');

const OBSERVED = {
    live: {
        produced: ['live.stream.started', 'live.stream.ended'],
        source: 'OpenVibe.Live server/events/stream-events.js (event_outbox, visibility public, priority important)',
    },
    media: {
        produced: ['media.vod.ready', 'media.vod.failed', 'media.clip.ready', 'media.clip.failed', 'media.object.uploaded', 'media.storage.alert', 'media.storage.recovered'],
        source: 'OpenVibe.Media server/events.js TYPES (event_outbox, visibility internal)',
    },
    network: {
        produced: ['network.module.updated'],
        source: 'OpenVibe.Network server/identity/module-events.js (network_event_outbox, visibility internal)',
    },
};

const SEGMENT = /^[a-z0-9_]+$/;
function patternRe(p) {
    const body = String(p).split('.').map(seg => (seg === '*' ? '[a-z0-9_]+(?:\\.[a-z0-9_]+)*' : SEGMENT.test(seg) ? seg : null));
    if (body.includes(null)) return null;
    return new RegExp(`^${body.join('\\.')}$`);
}
const isPattern = (p) => String(p).includes('*');
const uniq = (a) => [...new Set(a)];

/** Network's consumed topics: its Events consumer's TOPICS (required lazily; it pulls in the SDK). */
function networkConsumed() {
    try { return [...require('../notifications/events-consumer').TOPICS]; } catch { return []; }
}

/**
 * The manifest's event lists with Network's observations merged in. `observed` names what the
 * manifest itself lacks, so a reader can tell declared from observed.
 */
function eventsOf(m, { consumedByNetwork = networkConsumed() } = {}) {
    const produced = m.eventsProduced || [];
    const consumed = m.eventsConsumed || [];
    const o = OBSERVED[m.id];
    const addP = o ? o.produced.filter(t => !produced.includes(t)) : [];
    const addC = m.id === 'network' ? consumedByNetwork.filter(t => !consumed.includes(t)) : [];
    const observed = addP.length || addC.length
        ? { ...(addP.length ? { eventsProduced: addP } : {}), ...(addC.length ? { eventsConsumed: addC } : {}),
            source: [addP.length ? o.source : null, addC.length ? 'OpenVibe.Network server/notifications/events-consumer.js TOPICS' : null].filter(Boolean).join('; ') }
        : null;
    return { eventsProduced: uniq([...produced, ...addP]), eventsConsumed: uniq([...consumed, ...addC]), observed };
}

function payloadContracts() {
    const out = new Map();
    for (const c of contracts.catalog) {
        if (!String(c.schema || '').startsWith('events/payloads/')) continue;
        const major = Number(String(c.version).split('.')[0]) || 1;
        let $id = null;
        try { $id = contracts.schema(c.id).$id || null; } catch { /* listed without a schema */ }
        const prev = out.get(c.id);
        if (prev && prev.major > major) continue;
        out.set(c.id, { id: `${c.id}@${major}`, version: c.version, major, owner: c.owner, status: c.status, visibility: c.visibility, adr: c.adr || null, $id });
    }
    return out;
}

/** Every topic: producers, consumers (with the pattern that matched), and its payload contract. */
function buildTopics({ manifests = contracts.services.manifests, consumedByNetwork } = {}) {
    const payloads = payloadContracts();
    const topics = new Map();
    const row = (t) => {
        if (!topics.has(t)) topics.set(t, { topic: t, status: null, producers: [], consumers: [], services: [], payload_contract: null });
        return topics.get(t);
    };
    const events = manifests.map(m => ({ id: m.id, ...eventsOf(m, consumedByNetwork ? { consumedByNetwork } : undefined) }));
    for (const e of events) {
        for (const t of e.eventsProduced) {
            const r = row(t);
            const how = e.observed && (e.observed.eventsProduced || []).includes(t) ? 'observed' : 'manifest';
            r.producers.push({ service: e.id, declared: how });
        }
    }
    for (const [t, p] of payloads) { const r = row(t); r.payload_contract = p; }
    const patterns = [];
    for (const e of events) {
        for (const t of e.eventsConsumed) {
            const how = e.observed && (e.observed.eventsConsumed || []).includes(t) ? 'observed' : 'manifest';
            if (isPattern(t)) { const re = patternRe(t); if (re) patterns.push({ service: e.id, pattern: t, re, declared: how }); continue; }
            row(t).consumers.push({ service: e.id, pattern: t, declared: how });
        }
    }
    for (const r of topics.values()) {
        for (const p of patterns) if (p.re.test(r.topic)) r.consumers.push({ service: p.service, pattern: p.pattern, declared: p.declared });
        r.services = uniq([...r.producers.map(p => p.service), ...r.consumers.map(c => c.service)]);
        r.status = r.producers.length ? (r.payload_contract && r.payload_contract.status === 'planned' ? 'planned' : 'produced') : 'consumed-only';
    }
    return {
        topics: [...topics.values()].sort((a, b) => a.topic.localeCompare(b.topic)),
        patterns: patterns.map(({ re, ...p }) => p),
    };
}

module.exports = { OBSERVED, buildTopics, eventsOf, patternRe, payloadContracts };
