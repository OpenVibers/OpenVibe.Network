'use strict';

/**
 * Names for the owner's machine-access and agent pages (openvibe.link/machines): a request, a grant or an agent
 * thread names its machines, people and agents by id, and the page must say "Jo's laptop asks for access", never
 * "lnk_01J…". One batched read per kind of name, only for ids the person's own rows already carry: nothing here lets
 * a page look up a machine or a person it is not party to.
 */

const uniq = (xs) => [...new Set(xs.filter(Boolean).map(String))];
const marks = (n) => Array.from({ length: n }, () => '?').join(', ');

/** Link principal id → the machine's name. */
async function machineNames(db, ids) {
    const list = uniq(ids);
    if (!list.length) return new Map();
    const rows = await db.prepare(`SELECT id, name FROM platform_node_principals WHERE id IN (${marks(list.length)})`).all(...list);
    return new Map(rows.map((r) => [r.id, r.name || 'A machine']));
}

/** Subject → { username, display_name }: the public name a profile shows. */
async function people(db, subjects) {
    const list = uniq(subjects);
    if (!list.length) return new Map();
    const rows = await db.prepare(`SELECT subject_id, username, display_name FROM users WHERE subject_id IN (${marks(list.length)})`).all(...list);
    return new Map(rows.map((r) => [r.subject_id, { username: r.username, display_name: r.display_name || r.username }]));
}

/** Agent id → { name, kind, machine_id, owner }. */
async function agents(db, ids) {
    const list = uniq(ids);
    if (!list.length) return new Map();
    const rows = await db.prepare(`SELECT id, name, kind, machine_id, service, owner_subject FROM agent_directory WHERE id IN (${marks(list.length)})`).all(...list);
    return new Map(rows.map((r) => [r.id, { name: r.name, kind: r.kind, machine_id: r.machine_id || null, service: r.service || null, owner: r.owner_subject }]));
}

const personOf = (map, subject) => (subject && map.get(subject)) || null;

/**
 * Requests or grants (from_principal, to_principal, from_owner, to_owner) with their machines' and people's names,
 * and the side the viewer is on: "in" (asked of the viewer), "out" (the viewer asked) or "own" (between the viewer's
 * own machines).
 */
async function nameAccessRows(db, rows, viewer) {
    const machines = await machineNames(db, rows.flatMap((r) => [r.from_principal, r.to_principal]));
    const who = await people(db, rows.flatMap((r) => [r.from_owner, r.to_owner]));
    return rows.map((r) => ({
        ...r,
        side: r.from_owner === viewer && r.to_owner === viewer ? 'own' : r.to_owner === viewer ? 'in' : 'out',
        from_machine: { id: r.from_principal, name: machines.get(r.from_principal) || 'A machine' },
        to_machine: { id: r.to_principal, name: machines.get(r.to_principal) || 'A machine' },
        from_person: personOf(who, r.from_owner),
        to_person: personOf(who, r.to_owner),
    }));
}

/** Agent threads ({ from, to } agent ids, tasks) with each agent's name, its machine and its person. */
async function nameThreads(db, threads, viewer) {
    const byId = await agents(db, threads.flatMap((t) => [t.from, t.to]));
    const machines = await machineNames(db, [...byId.values()].map((a) => a.machine_id));
    const who = await people(db, [...byId.values()].map((a) => a.owner));
    const named = (id) => {
        const a = byId.get(id);
        if (!a) return { id, name: 'An agent', kind: null, machine: null, person: null, mine: false };
        return { id, name: a.name, kind: a.kind, machine: a.machine_id ? { id: a.machine_id, name: machines.get(a.machine_id) || 'A machine' } : null,
            service: a.service, person: personOf(who, a.owner), mine: a.owner === viewer };
    };
    return threads.map((t) => ({ ...t, from_agent: named(t.from), to_agent: named(t.to) }));
}

/** The viewer's own agents, with the name of the machine each runs on. */
async function nameAgents(db, list) {
    const machines = await machineNames(db, list.map((a) => a.machine_id));
    return list.map((a) => (a.machine_id ? { ...a, machine: { id: a.machine_id, name: machines.get(a.machine_id) || 'A machine' } } : a));
}

module.exports = { machineNames, people, agents, nameAccessRows, nameThreads, nameAgents };
