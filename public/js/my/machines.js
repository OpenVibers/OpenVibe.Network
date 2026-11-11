/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my#machines, /machines): your machines (plan L34, the machines hub).
   Each machine you paired: whether it is online, what it runs, the roles it plays for you (Codes jobs, desks, your
   own models, a robot), a new name, and revoking it. "Pair a machine" shows a one-time code and the command to run,
   then watches for the machine to arrive. Pairing and roles only ever come from your own session (Network refuses an
   app's token there). Classic script, global scope: my/core.js's apiFetch and showSection; built from DOM nodes.
   ═══════════════════════════════════════════════════════════════ */
let mcRoles = null;        // the catalogue: [{ id, name, installs, shows }]
let mcWatch = 0;           // the timer that watches for a newly paired machine

function mcEl(tag, cls, kids, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    (kids || []).forEach((c) => { if (c != null) n.append(c); });
    return n;
}
const mcIcon = (name) => mcEl('i', `fa-solid ${name}`, [], { 'aria-hidden': 'true' });
function mcAgo(at) {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
}
const MC_KIND = { onboard: 'This computer', bridge: 'A bridge', server: 'A server' };
const MC_ROLE_ICON = { 'codes.worker': 'fa-code', 'desks.host': 'fa-display', 'ai.host': 'fa-microchip', 'bot.robot': 'fa-robot' };

function mcSay(text, bad) {
    const s = document.getElementById('mc-status');
    if (!s) return;
    s.textContent = text || '';
    s.classList.toggle('is-bad', !!bad);
}

/** One machine: its state, what it runs, its roles as switches, and Rename / Revoke. */
function mcCard(m) {
    const card = mcEl('article', 'mc-card', [], { 'data-machine': m.id });
    const dot = mcEl('span', `mc-dot ${m.online ? 'is-on' : ''}`, [], { 'aria-hidden': 'true' });
    const name = mcEl('h4', 'mc-name', [m.name || MC_KIND[m.kind] || 'A machine']);
    const state = mcEl('span', 'mc-state', [m.online ? 'Online' : (m.last_seen_at ? `Offline · seen ${mcAgo(m.last_seen_at)}` : 'Offline')]);
    const os = String(m.os || '').toLowerCase();
    const osIcon = os.includes('mac') || os.includes('darwin') ? 'fa-apple' : os.includes('linux') ? 'fa-linux' : 'fa-laptop';
    const meta = mcEl('p', 'mc-meta', [mcIcon(osIcon), ' ', [MC_KIND[m.kind], m.os, m.node_version ? `Node ${m.node_version}` : ''].filter(Boolean).join(' · ')]);
    const head = mcEl('div', 'mc-head', [dot, mcEl('div', 'mc-title', [name, state]), meta]);
    card.append(head);
    const roleChips = (m.roles || []).map((id) => (mcRoles || []).find((r) => r.id === id)).filter(Boolean);
    card.append(mcEl('div', 'mc-role-chips', roleChips.length ? roleChips.map((r) => mcEl('span', 'mc-role-chip', [r.name])) : [mcEl('span', 'mc-role-chip is-empty', ['No roles assigned'])]));
    card.append(mcMuseStatus(m));
    (m.pools || []).forEach((pool) => card.append(mcPoolBlock(pool)));

    if (Array.isArray(m.running) && m.running.length) {
        card.append(mcEl('ul', 'mc-running', m.running.slice(0, 6).map((r) => mcEl('li', '', [String((r && (r.title || r.kind || r.id)) || r)]))));
    }

    // The roles: a switch each; a change saves the whole set at once.
    const roles = mcEl('fieldset', 'mc-roles mc-role-set', [mcEl('legend', '', ['What it does for you'])]);
    (mcRoles || []).forEach((role) => {
        const id = `mc-${m.id}-${role.id.replace(/\W/g, '-')}`;
        const box = mcEl('input', '', [], { type: 'checkbox', id, value: role.id });
        box.checked = (m.roles || []).includes(role.id);
        box.addEventListener('change', () => mcSaveRoles(card, m));
        roles.append(mcEl('label', 'mc-role', [box, mcEl('span', 'mc-role-ic', [mcIcon(MC_ROLE_ICON[role.id] || 'fa-gear')]), mcEl('span', 'mc-role-t', [mcEl('b', '', [role.name]), mcEl('small', '', [role.shows || ''])])], { for: id }));
    });
    card.append(roles);

    const own = mcOwnerSwitches(m);
    if (own) card.append(own);
    const screen = mcScreenBlock(card, m);
    if (screen) card.append(screen);
    const links = mcSharesBlock(m);
    if (links) card.append(links);
    const desks = mcDesksBlock(card, m);
    if (desks) card.append(desks);

    const acts = mcEl('div', 'mc-acts');
    const rename = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-pen'), ' Rename'], { type: 'button' });
    rename.addEventListener('click', () => mcRename(card, m, name));
    const revoke = mcEl('button', 'btn btn-small mc-revoke', [mcIcon('fa-link-slash'), ' Revoke'], { type: 'button' });
    revoke.addEventListener('click', () => mcConfirmRevoke(acts, m));
    acts.append(rename, revoke);
    const menu = mcEl('details', 'mc-action-menu');
    menu.append(mcEl('summary', '', ['Actions']));
    menu.append(acts);
    card.append(menu);
    return card;
}

/** Muse runs on this machine under its owner's own sign-in; the last Link reading is only a status. */
function mcMuseStatus(m) {
    const muse = Array.isArray(m.fleet) ? m.fleet.find((a) => a.agent === 'muse') : null;
    const fleetAge = m.fleet_at ? Date.now() - Date.parse(m.fleet_at) : NaN;
    const stale = m.fleet_at && (!Number.isFinite(fleetAge) || fleetAge > 5 * 60000);
    const state = !m.online ? 'Offline' : !muse || stale ? 'Status unavailable' : !muse.installed ? 'Not installed' : !muse.signed_in ? 'Sign in' : 'Ready';
    const row = mcEl('div', 'mc-role', [
        mcEl('span', 'mc-role-ic', [mcIcon('fa-code')]),
        mcEl('span', 'mc-role-t', [mcEl('b', '', ['Muse Code']), mcEl('small', '', [state])]),
    ]);
    const setup = mcEl('details', '', [mcEl('summary', '', ['Set up Muse Code'])]);
    setup.append(mcEl('p', '', ['Install Muse Code on this machine, run ', mcEl('code', '', ['muse login']), ', then run the Link installer again with ', mcEl('code', '', ['--plan-logins']), '. Jobs use your own Muse sign-in.']));
    const windows = /windows/i.test(String(m.os || ''));
    setup.append(mcEl('pre', '', [mcEl('code', '', [windows ? 'irm https://dev.meta.ai/install.ps1 | iex' : 'curl -fsSL https://dev.meta.ai/install.sh | sh'])]));
    setup.append(mcEl('p', '', [mcEl('a', '', ['Worker setup'], { href: 'https://github.com/OpenVibers/OpenVibe.Link/blob/main/docs/worker.md' })]));
    return mcEl('div', 'mc-roles', [row, setup]);
}

/* ── The owner's switches, the live screen, its links, and the machine's desks ───────────────────────────────
   Everything here answers from what Bot reports (the machine's controls) and calls the hub's routes, which call
   Bot as the person. A switch is the person's own click; an app's token cannot reach these routes (Network refuses
   it), so nothing turns on what an agent may do by itself. */

/** A labelled switch row: a checkbox, an icon, a bold label and the sentence that says what it allows. */
function mcSwitchRow(id, label, note, checked, onChange) {
    const box = mcEl('input', '', [], { type: 'checkbox', id });
    box.checked = checked === true;
    box.addEventListener('change', () => onChange(box));
    return mcEl('label', 'mc-role', [box, mcEl('span', 'mc-role-ic', [mcIcon(id.endsWith('-agent') ? 'fa-robot' : 'fa-tower-broadcast')]),
        mcEl('span', 'mc-role-t', [mcEl('b', '', [label]), mcEl('small', '', [note])])], { for: id });
}

/** The two switches the removed page had for the person's agent and watches, off unless Bot says they are on. */
function mcOwnerSwitches(m) {
    const c = m.controls || null;
    if (!c || !c.computer) return null;
    const field = mcEl('fieldset', 'mc-roles mc-switches', [mcEl('legend', '', ['For your agent and your watches'])]);
    field.append(mcSwitchRow(`mc-${m.id}-agent`, 'Let my agent use this computer',
        'Your OpenVibe.Actor agent may use its terminal, files and screen as you, at the level set on the computer. Off until you turn it on.',
        c.agent_computer, (box) => mcSaveSwitch(m, box, 'agent-computer', `Saved. ${m.name || 'The machine'} ${box.checked ? 'may be used by your agent.' : 'is off limits to your agent now.'}`)));
    if (c.probe) {
        field.append(mcSwitchRow(`mc-${m.id}-watch`, 'Let my watches check things from this computer',
            'OpenVibe.Watch may probe your own network from here for your watches: one GET or one TCP connection, to private addresses only.',
            c.watch_probe, (box) => mcSaveSwitch(m, box, 'watch-probe', `Saved. Your watches ${box.checked ? 'may check from this computer.' : 'no longer check from here.'}`)));
    }
    return field;
}

async function mcSaveSwitch(m, box, route, done) {
    const before = !box.checked;
    box.disabled = true;
    try {
        const out = await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/${route}`, { method: 'POST', body: JSON.stringify({ on: box.checked }) });
        if (out && out.machine && out.machine.controls) m.controls = out.machine.controls;
        mcSay(done);
    } catch (e) {
        box.checked = before;
        mcSay(e.message || 'The switch could not be saved.', true);
    } finally { box.disabled = false; }
}

/** The live screen: Show/Stop, ten minutes by Bot's default, the picture, and Take over. */
function mcScreenBlock(card, m) {
    const c = m.controls || null;
    const screen = c && c.screen;
    if (!screen || !screen.available) return null;
    // Offline with nothing showing: there is no picture to start; the links below can still be revoked.
    if (!m.online && !screen.live) return null;
    const block = mcEl('div', 'mc-screen-block', [], { 'data-screen-block': m.id });
    const acts = mcEl('div', 'mc-acts');
    const show = mcEl('button', 'btn btn-primary btn-small', [mcIcon('fa-display'), screen.live ? ' Watch my screen' : ' Show my screen'], { type: 'button' });
    show.addEventListener('click', async () => {
        show.disabled = true;
        try {
            await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/screen`, { method: 'POST', body: JSON.stringify({ desk: 'main' }) });
            mcSay('Showing the screen: the picture appears in a few seconds.');
            mcMountPlayer(card, block, m, 'main', true);
            show.hidden = true;
        } catch (e) { mcSay(e.message || 'The screen could not be shown.', true); }
        finally { show.disabled = false; }
    });
    const stop = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-stop'), ' Stop showing my screen'], { type: 'button' });
    stop.addEventListener('click', async () => {
        stop.disabled = true;
        try {
            await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/screen`, { method: 'DELETE' });
            mcUnmountPlayer(card);
            mcSay('Your screen is no longer shown.');
            show.hidden = false;
        } catch (e) { mcSay(e.message || 'The screen could not be stopped.', true); }
        finally { stop.disabled = false; }
    });
    acts.append(show, stop);
    block.append(acts, mcEl('p', 'mc-confirm', ['Live to you only, for 10 minutes. Nothing is recorded, and the computer says on its desktop that its screen is live.']));
    // A screen already showing when the card was drawn: connect without starting a second one.
    if (screen.live && m.online) mcMountPlayer(card, block, m, 'main', false);
    return block;
}

/** The links made for this machine's screen: list them, and revoke one for good. */
function mcSharesBlock(m) {
    const c = m.controls || {};
    if (!c.computer || !((c.screen && c.screen.available) || (c.desk && c.desk.available))) return null;
    const block = mcEl('div', 'mc-shares');
    const button = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-link'), ' Screen links'], { type: 'button' });
    const list = mcEl('div', 'mc-shares-list');
    list.hidden = true;
    const draw = (shares) => {
        if (!shares.length) {
            list.replaceChildren(mcEl('p', 'mc-confirm', ['No screen links. Your agent makes one when it shows you a desk.']));
            return;
        }
        list.replaceChildren(...shares.map((s) => {
            const meta = ` · ${s.control ? 'watch and use' : 'watch only'}${s.desk && s.desk !== 'main' ? ` · ${s.desk}` : ''}${s.expires_at ? ` · until ${new Date(s.expires_at).toLocaleString()}` : ''}`;
            const row = mcEl('div', 'mc-share-row', [mcEl('span', '', [mcEl('b', '', [s.label || 'A screen link']), mcEl('small', '', [meta])])]);
            const revoke = mcEl('button', 'btn btn-small mc-revoke', ['Revoke'], { type: 'button' });
            revoke.addEventListener('click', async () => {
                revoke.disabled = true;
                try {
                    await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/shares/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
                    mcSay('The screen link is revoked.');
                    row.remove();
                } catch (e) { mcSay(e.message || 'The link could not be revoked.', true); revoke.disabled = false; }
            });
            row.append(revoke);
            return row;
        }));
    };
    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            const out = await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/shares`);
            draw((out && out.shares) || []);
            list.hidden = false;
        } catch (e) { mcSay(e.message || 'The screen links could not be read.', true); }
        finally { button.disabled = false; }
    });
    block.append(button, list);
    return block;
}

/** The desks running on this machine: watched/taken over, stopped, or put on the owner's Live channel. */
function mcDesksBlock(card, m) {
    const d = m.controls && m.controls.desk;
    if (!d || !d.available || !m.online) return null;
    const block = mcEl('div', 'mc-desks');
    const button = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-display'), ' See its desks'], { type: 'button' });
    const list = mcEl('div', 'mc-desks-list');
    list.hidden = true;
    const draw = (desks, maxDesks) => {
        if (!desks.length) {
            list.replaceChildren(mcEl('p', 'mc-confirm', ['No desks are running. An agent\'s task starts a desk of its own here, and stops it when it is done.']));
            return;
        }
        list.replaceChildren(...desks.map((desk) => {
            const meta = ` · ${desk.kind || 'desk'}${Number.isInteger(desk.width) ? ` · ${desk.width}×${desk.height}` : ''}`;
            const row = mcEl('div', 'mc-desk-row', [mcEl('span', '', [mcEl('b', '', [desk.desk]), mcEl('small', '', [meta])])]);
            const acts = mcEl('div', 'mc-acts');
            const watch = mcEl('button', 'btn btn-small', ['Watch and take over'], { type: 'button' });
            watch.addEventListener('click', async () => {
                watch.disabled = true;
                try {
                    await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/screen`, { method: 'POST', body: JSON.stringify({ desk: desk.desk }) });
                    mcMountPlayer(card, block, m, desk.desk, true);
                    mcSay(`Showing ${desk.desk}.`);
                } catch (e) { mcSay(e.message || 'The desk could not be shown.', true); }
                finally { watch.disabled = false; }
            });
            const stop = mcEl('button', 'btn btn-outline btn-small', ['Stop'], { type: 'button' });
            stop.addEventListener('click', async () => {
                stop.disabled = true;
                try {
                    await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/desks/${encodeURIComponent(desk.desk)}/stop`, { method: 'POST', body: '{}' });
                    mcSay(`${desk.desk} is stopped.`);
                } catch (e) { mcSay(e.message || 'The desk could not be stopped.', true); stop.disabled = false; }
            });
            const live = mcEl('details', 'mc-desk-live', [mcEl('summary', 'btn btn-outline btn-small', ['Show live on my channel']),
                mcEl('p', 'mc-confirm', ['Everyone can watch this desk on your OpenVibe Live channel for up to 30 minutes: what your agent does and every page it opens, signed-in pages included.']),
                (() => {
                    const go = mcEl('button', 'btn btn-small mc-revoke', ['Go live with this desk'], { type: 'button' });
                    go.addEventListener('click', async () => {
                        go.disabled = true;
                        try {
                            const out = await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/desks/${encodeURIComponent(desk.desk)}/live`, { method: 'POST', body: '{}' });
                            mcSay(out && out.channel_url ? `Live on ${out.channel_url} for up to 30 minutes.` : `${desk.desk} is live on your OpenVibe Live channel for up to 30 minutes.`);
                            if (out && out.channel_url) list.append(mcEl('p', 'mc-confirm', [mcEl('a', '', [out.channel_url], { href: out.channel_url })]));
                        } catch (e) { mcSay(e.message || 'The desk could not go live.', true); go.disabled = false; }
                    });
                    return go;
                })()]);
            acts.append(watch, stop, live);
            row.append(acts);
            return row;
        }).concat(maxDesks ? [mcEl('p', 'mc-confirm', [`At most ${maxDesks} whole ${maxDesks === 1 ? 'desk' : 'desks'} at once here; a browser desk counts as half.`])] : []));
    };
    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            const out = await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/desks`);
            draw((out && out.desks) || [], out && out.max_desks);
            list.hidden = false;
        } catch (e) { mcSay(e.message || 'The machine\'s desks could not be read.', true); }
        finally { button.disabled = false; }
    });
    block.append(button, list);
    return block;
}

/* ── The picture: OpenRestream's viewer signaling, the same mediasoup flow the Bot page used ───────────────── */

const MC_MEDIASOUP_URL = 'https://esm.sh/mediasoup-client@3.18.7';
let mcMediasoup = null;
const mcLoadMediasoup = () => (mcMediasoup ||= import(MC_MEDIASOUP_URL).then(
    (m) => m.Device || (m.default && m.default.Device),
    (e) => { mcMediasoup = null; throw e; }));

function mcViewerWait(ws, type, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) return reject(new Error('the screen signaling socket closed'));
        let timer;
        const done = (finish) => { clearTimeout(timer); ws.removeEventListener('message', onMessage); ws.removeEventListener('close', onClose); finish(); };
        const onMessage = (e) => {
            let m; try { m = JSON.parse(e.data); } catch { return; }
            if (m.type === type) done(() => resolve(m));
            else if (m.type === 'watch-queued') done(() => reject(new Error('nothing is publishing yet')));
            else if (m.type === 'sfu-error' || m.type === 'sfu-viewer-error') done(() => reject(new Error(m.error || m.type)));
        };
        const onClose = () => done(() => reject(new Error('the screen signaling socket closed')));
        timer = setTimeout(() => done(() => reject(new Error(`no ${type} from the screen`))), timeoutMs);
        ws.addEventListener('message', onMessage);
        ws.addEventListener('close', onClose);
    });
}

/** Play a live screen's viewer URL (the mediasoup sfu-viewer flow) in `video`; stop() ends it for good. */
function mcPlayStream(video, url, say) {
    let current = null, timer = null, attempt = 0, stopped = false;
    function teardown() {
        const session = current; current = null;
        video.srcObject = null;
        if (!session) return;
        for (const c of session.consumers) { try { c.close(); } catch { /* gone */ } }
        if (session.transport) { try { session.transport.close(); } catch { /* gone */ } }
        if (session.ws) { try { session.ws.close(); } catch { /* gone */ } }
    }
    function retry() {
        if (timer || stopped) return;
        video.hidden = true; teardown();
        timer = setTimeout(() => { timer = null; connect(); }, Math.min(10000, 500 * 2 ** attempt++));
    }
    async function connect() {
        const session = { ws: null, transport: null, consumers: [] };
        const stale = () => current !== session;
        current = session;
        try {
            const ws = new WebSocket(url);
            session.ws = ws;
            await new Promise((open, fail) => { ws.addEventListener('open', open, { once: true }); ws.addEventListener('close', () => fail(new Error('the screen signaling socket closed')), { once: true }); });
            if (stale()) return;
            ws.send(JSON.stringify({ type: 'watch' }));
            const ready = await mcViewerWait(ws, 'sfu-viewer-ready');
            if (stale()) return;
            if (!ready.producers || !ready.producers.length) throw new Error('the screen has no live track yet');
            const Device = await mcLoadMediasoup();
            if (stale()) return;
            const device = new Device();
            await device.load({ routerRtpCapabilities: ready.rtpCapabilities });
            if (stale()) return;
            ws.send(JSON.stringify({ type: 'sfu-viewer-create-transport' }));
            const created = await mcViewerWait(ws, 'sfu-viewer-transport-created');
            if (stale()) return;
            const transport = device.createRecvTransport({ id: created.id, iceParameters: created.iceParameters, iceCandidates: created.iceCandidates, dtlsParameters: created.dtlsParameters, iceServers: created.iceServers || [] });
            session.transport = transport;
            transport.on('connect', ({ dtlsParameters }, cb, errb) => {
                if (stale()) return errb(new Error('the screen session is gone'));
                ws.send(JSON.stringify({ type: 'sfu-viewer-connect-transport', transportId: transport.id, dtlsParameters }));
                mcViewerWait(ws, 'sfu-viewer-transport-connected').then(() => cb(), () => errb(new Error('the screen transport did not connect')));
            });
            const media = new MediaStream();
            for (const producer of ready.producers) {
                ws.send(JSON.stringify({ type: 'sfu-viewer-consume', transportId: transport.id, producerId: producer.id, rtpCapabilities: device.rtpCapabilities }));
                const consumed = await mcViewerWait(ws, 'sfu-viewer-consumed');
                if (stale()) return;
                const consumer = await transport.consume({ id: consumed.id, producerId: consumed.producerId, kind: consumed.kind, rtpParameters: consumed.rtpParameters });
                session.consumers.push(consumer);
                media.addTrack(consumer.track);
            }
            if (stale()) return;
            video.srcObject = media;
            video.hidden = false;
            say('Live.');
            attempt = 0;
            await video.play().catch(() => { /* autoplay holds the track anyway */ });
            ws.addEventListener('close', () => { if (!stale()) retry(); });
        } catch (e) { if (!stale()) retry(); }
    }
    connect();
    return { stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } teardown(); video.hidden = true; } };
}

/** Mount one player on the card (stopping any other) and poll the screen's state for its viewer URL. */
function mcMountPlayer(card, block, m, desk, takeOver) {
    mcUnmountPlayer(card);
    const figure = mcEl('figure', 'mc-screen', [], { tabindex: '0', 'data-desk': desk });
    const video = mcEl('video', '', [], { muted: '', autoplay: '', playsinline: '' });
    video.hidden = true;
    const status = mcEl('p', 'mc-confirm', ['Waiting for the machine…'], { role: 'status' });
    const use = mcEl('input', '', [], { type: 'checkbox', id: `mc-${m.id}-${desk.replace(/\W/g, '-')}-use` });
    const useRow = mcEl('label', 'mc-role mc-takeover', [use, mcEl('span', 'mc-role-ic', [mcIcon('fa-keyboard')]),
        mcEl('span', 'mc-role-t', [mcEl('b', '', ['Use the mouse and keyboard']), mcEl('small', '', [desk === 'main' ? 'Clicks and keys on the picture go to the computer.' : 'While you use it, the agent waits on this desk.'])])], { for: use.getAttribute('id') });
    const stop = mcEl('button', 'btn btn-outline btn-small', ['Stop showing it'], { type: 'button' });
    let player = null, timer = null, stopped = false;
    const say = (t) => { status.textContent = t || ''; };
    const poll = async () => {
        if (stopped) return;
        let s = null;
        try { s = await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/screen`); } catch (e) { say(e.message || 'The screen could not be read.'); }
        if (s && s.live && s.signaling_url && !player) { say('Connecting to the screen…'); player = mcPlayStream(video, s.signaling_url, say); }
        else if (player && s && s.state === 'off') { player.stop(); player = null; say('The screen is no longer shown.'); }
        else if (!player) say(s && s.online === false ? 'The machine is offline.' : 'Waiting for the machine…');
        if (!stopped) timer = setTimeout(poll, player ? 5000 : 1500);
    };
    stop.addEventListener('click', async () => {
        stop.disabled = true;
        try {
            await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/screen`, { method: 'DELETE' });
            say('Stopped.');
        } catch (e) { say(e.message || 'The screen could not be stopped.'); }
        stopped = true; clearTimeout(timer);
        if (player) { player.stop(); player = null; }
        stop.disabled = false;
    });
    mcAttachTakeOver(figure, video, m, use);
    figure.append(video, status, useRow, stop);
    block.append(figure);
    card._mcPlayer = { stop() { stopped = true; clearTimeout(timer); if (player) player.stop(); }, figure, use };
    poll();
    if (takeOver) figure.focus();
    return card._mcPlayer;
}

function mcUnmountPlayer(card) {
    const p = card && card._mcPlayer;
    if (!p) return;
    p.stop();
    if (p.figure && p.figure.parent) p.figure.remove();
    card._mcPlayer = null;
}

/** The owner's mouse and keyboard on the picture, as the removed page's "Take over": positions in picture pixels. */
function mcAttachTakeOver(figure, video, m, use) {
    const send = (value) => apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/screen/input`, { method: 'POST', body: JSON.stringify(value) }).catch((e) => mcSay(e.message || 'The computer did not do it.', true));
    const at = (ev) => {
        if (!video.videoWidth) return null;
        const r = video.getBoundingClientRect();
        const scale = Math.min(r.width / video.videoWidth, r.height / video.videoHeight);
        const ox = (r.width - video.videoWidth * scale) / 2, oy = (r.height - video.videoHeight * scale) / 2;
        const x = Math.round((ev.clientX - r.left - ox) / scale), y = Math.round((ev.clientY - r.top - oy) / scale);
        return x < 0 || y < 0 || x > video.videoWidth || y > video.videoHeight ? null : { x, y, width: video.videoWidth, height: video.videoHeight };
    };
    const on = () => !!(use && use.checked);
    let clickTimer = null;
    figure.addEventListener('click', (ev) => { if (!on()) return; const p = at(ev); if (!p) return; ev.preventDefault(); clearTimeout(clickTimer); clickTimer = setTimeout(() => send({ action: 'click', ...p }), 220); });
    figure.addEventListener('dblclick', (ev) => { if (!on()) return; const p = at(ev); if (!p) return; ev.preventDefault(); clearTimeout(clickTimer); send({ action: 'double_click', ...p }); });
    figure.addEventListener('contextmenu', (ev) => { if (!on()) return; const p = at(ev); if (!p) return; ev.preventDefault(); send({ action: 'right_click', ...p }); });
    let wheel = 0, wheelAt = null, wheelTimer = null;
    figure.addEventListener('wheel', (ev) => {
        if (!on()) return; const p = at(ev); if (!p) return; ev.preventDefault();
        wheel += ev.deltaY; wheelAt = p; clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => { const dy = Math.max(-20, Math.min(20, Math.round(wheel / 60))); wheel = 0; if (dy) send({ action: 'scroll', ...wheelAt, dy }); }, 150);
    }, { passive: false });
    const NAMES = { Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', Insert: 'Insert', ' ': 'space' };
    let text = '', textTimer = null;
    const flush = () => { if (text) { const t = text; text = ''; send({ action: 'type', text: t }); } };
    figure.addEventListener('keydown', (ev) => {
        if (!on()) return;
        const mods = [ev.ctrlKey && 'ctrl', ev.altKey && 'alt', ev.metaKey && 'super'].filter(Boolean);
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(ev.key)) return;
        ev.preventDefault();
        if (!mods.length && ev.key.length === 1) { text += ev.key; clearTimeout(textTimer); textTimer = setTimeout(flush, 120); return; }
        flush();
        const name = NAMES[ev.key] || (/^F\d{1,2}$/.test(ev.key) ? ev.key : (ev.key.length === 1 ? ev.key.toLowerCase() : null));
        if (!name || !/^[A-Za-z0-9_]+$/.test(name)) return;
        if (ev.shiftKey && mods.length) mods.push('shift');
        send({ action: 'key', keys: [...mods, name].join('+') });
    });
}


async function mcSaveRoles(card, m) {
    const roles = [...card.querySelectorAll('.mc-role-set input')].filter((b) => b.checked).map((b) => b.value);
    card.querySelectorAll('.mc-role-set input').forEach((b) => { b.disabled = true; });
    try {
        const out = await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/roles`, { method: 'PUT', body: JSON.stringify({ roles }) });
        m.roles = (out && out.machine && out.machine.roles) || roles;
        mcSay(`Saved. ${m.name || 'The machine'} picks this up at its next check-in.`);
    } catch (e) {
        mcSay(e.message || 'The roles could not be saved.', true);
        card.querySelectorAll('.mc-role-set input').forEach((b) => { b.checked = (m.roles || []).includes(b.value); });
    } finally {
        card.querySelectorAll('.mc-role-set input').forEach((b) => { b.disabled = false; });
    }
}

function mcRename(card, m, nameEl) {
    const input = mcEl('input', 'mc-rename', [], { type: 'text', maxlength: '80', 'aria-label': 'New name' });
    input.value = m.name || '';
    const save = async () => {
        const v = input.value.trim();
        if (!v || v === m.name) { input.replaceWith(nameEl); return; }
        try {
            const out = await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}`, { method: 'PATCH', body: JSON.stringify({ name: v }) });
            m.name = (out && out.machine && out.machine.name) || v;
            nameEl.textContent = m.name;
            mcSay('Renamed.');
        } catch (e) { mcSay(e.message || 'The name could not be saved.', true); }
        input.replaceWith(nameEl);
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') input.replaceWith(nameEl); });
    input.addEventListener('blur', save);
    nameEl.replaceWith(input);
    input.focus(); input.select();
}

/** Revoking is for good: a second, explicit press, in the page. */
function mcConfirmRevoke(acts, m) {
    const keep = [...acts.childNodes];
    const sure = mcEl('button', 'btn btn-small mc-revoke is-sure', ['Revoke for good'], { type: 'button' });
    const back = mcEl('button', 'btn btn-outline btn-small', ['Keep it'], { type: 'button' });
    const note = mcEl('span', 'mc-confirm', ['It stops working for you at once; pairing it again needs a new code.']);
    back.addEventListener('click', () => acts.replaceChildren(...keep));
    sure.addEventListener('click', async () => {
        sure.disabled = true;
        try {
            await apiFetch(`/api/v1/machines/${encodeURIComponent(m.id)}/revoke`, { method: 'POST', body: '{}' });
            mcSay(`${m.name || 'The machine'} is revoked.`);
            loadMachines();
        } catch (e) { mcSay(e.message || 'It could not be revoked.', true); sure.disabled = false; }
    });
    acts.replaceChildren(note, sure, back);
    back.focus();
}

/** A one-time code and the command to run, then watch for the machine to arrive. */
async function mcPair() {
    const box = document.getElementById('mc-pair');
    const btn = document.getElementById('mc-pair-btn');
    if (!box) return;
    btn.disabled = true;
    try {
        const before = new Set([...document.querySelectorAll('[data-machine]')].map((c) => c.getAttribute('data-machine')));
        const out = await apiFetch('/api/v1/machines/pairings', { method: 'POST', body: '{}' });
        const p = (out && out.pairing) || {};
        const code = mcEl('p', 'mc-code', [String(p.code || '')]);
        code.setAttribute('aria-label', 'Pairing code');
        const copyCode = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-copy'), ' Copy code'], { type: 'button' });
        copyCode.addEventListener('click', () => navigator.clipboard.writeText(String(p.code || '')).then(() => mcSay('Code copied.')));
        const qr = p.qr_data ? mcEl('img', 'mc-qr', [], { src: p.qr_data, alt: 'Scan this QR code to read the pairing code' }) : null;
        const cmd = mcEl('pre', 'mc-cmd', [mcEl('code', '', [String(p.installer || '')])]);
        const copy = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-copy'), ' Copy the command'], { type: 'button' });
        copy.addEventListener('click', () => navigator.clipboard.writeText(String(p.installer || '')).then(() => mcSay('Copied. Run it on the machine.')));
        const until = p.expires_at ? mcEl('span', 'mc-until', [`The code works until ${new Date(p.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`]) : null;
        const wait = mcEl('p', 'mc-wait', [mcEl('span', 'mc-wait-dot', [], { 'aria-hidden': 'true' }), 'Waiting for your machine…'], { role: 'status' });
        const pairContent = [mcEl('h4', '', ['Pair your computer']), mcEl('ol', 'mc-steps', [mcEl('li', '', ['Open OpenVibe Link on the computer.']), mcEl('li', '', ['Enter this code or scan the QR code.']), mcEl('li', '', ['Give it a name when it connects.'])]), mcEl('div', 'mc-pair-code-row', [code, copyCode])];
        if (qr) pairContent.push(qr);
        pairContent.push(mcEl('p', 'muted', ['Or install Link with this command:']), cmd, mcEl('div', 'mc-pair-acts', [copy, until]), wait);
        box.replaceChildren(...pairContent);
        box.hidden = false;
        clearInterval(mcWatch);
        const t0 = Date.now();
        mcWatch = setInterval(async () => {
            if (Date.now() - t0 > 15 * 60000) { clearInterval(mcWatch); wait.textContent = 'No machine yet. Pair again for a new code.'; return; }
            const list = await apiFetch('/api/v1/machines').catch(() => null);
            const fresh = ((list && list.machines) || []).find((m) => !before.has(m.id));
            if (!fresh) return;
            clearInterval(mcWatch);
            const returnTo = new URLSearchParams(location.search).get('return_to');
            if (returnTo) {
                const done = new URL('https://openvibe.link/add-computer/complete');
                done.searchParams.set('return_to', returnTo);
                done.searchParams.set('machine', fresh.id);
                location.assign(done.toString());
                return;
            }
            box.hidden = true;
            mcSay(`${fresh.name || 'Your machine'} is paired. Choose what it does for you below.`);
            loadMachines();
        }, 5000);
    } catch (e) {
        mcSay(e.message || 'A code could not be made.', true);
    } finally { btn.disabled = false; }
}

async function loadMachines() {
    const list = document.getElementById('mc-list');
    if (!list) return;
    const count = document.getElementById('mc-count');
    try {
        if (!mcRoles) mcRoles = ((await apiFetch('/api/v1/machines/roles').catch(() => null)) || {}).roles || [];
        const out = await apiFetch('/api/v1/machines');
        const machines = (out && out.machines) || [];
        machines.sort((a, b) => (b.online === true) - (a.online === true));
        if (count) count.textContent = `${machines.length} paired · ${machines.filter((m) => m.online).length} online now`;
        if (!machines.length) {
            list.replaceChildren(mcEl('div', 'mc-empty', [mcIcon('fa-laptop'), mcEl('p', '', [mcEl('b', '', ['No machines yet.']), ' Pair your computer and it can run your Codes jobs, host your desks and serve your own models, under your account.'])]));
            return;
        }
        // Pools are an extra: when they cannot be read, the machines still show.
        const pools = (await apiFetch('/api/v1/machine-pools').catch(() => null)) || { pools: [], candidates: [] };
        mcNames = new Map(machines.map((m) => [m.id, m.name || MC_KIND[m.kind] || 'A machine']));
        for (const m of machines) m.pools = (pools.pools || []).filter((p) => p.machines.some((x) => x.id === m.id));
        list.replaceChildren(...machines.map(mcCard), ...mcPoolPickers(pools.candidates || []));
    } catch (e) {
        if (count) count.textContent = '';
        list.replaceChildren(mcEl('p', 'muted', [e.status === 401 ? 'Sign in to see your machines.' : 'Your machines could not be read just now.']));
    }
}

/* ── Pooled machines (bot.machine-pool@1): several of your machines on one local network serving one model together.
   The page proposes and stops a pool; each machine approves it on itself (in Node), never from here. ── */
let mcNames = new Map();     // machine id → the name its card shows
const mcName = (id) => mcNames.get(id) || 'A machine';
const mcGB = (mb) => `${(Number(mb) / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB`;

/** A pool on a member's card: who is the head, who has approved on itself, each machine's share, and Stop pool. */
function mcPoolBlock(pool) {
    const ready = pool.machines.every((x) => x.approved && x.ready);
    const waiting = pool.machines.filter((x) => !x.approved).length;
    const block = mcEl('fieldset', 'mc-roles mc-pool', [mcEl('legend', '', [`Pool of ${pool.machines.length} machines`])]);
    for (const x of pool.machines) {
        const state = !x.approved ? 'Waiting for approval on that machine' : x.ready ? 'Approved · ready' : 'Approved · paused or offline';
        block.append(mcEl('div', 'mc-role', [
            mcEl('span', 'mc-role-ic', [mcIcon(x.id === pool.head ? 'fa-crown' : 'fa-microchip')]),
            mcEl('span', 'mc-role-t', [mcEl('b', '', [mcName(x.id) + (x.id === pool.head ? ' (head)' : '')]),
                mcEl('small', '', [`${state} · ${Math.round(x.vram_share * 100)}% of the pool's VRAM and credits`])]),
        ]));
    }
    const note = waiting
        ? `${waiting} machine${waiting === 1 ? '' : 's'} still to approve this pool on itself, in Node (pool ${pool.id}).`
        : ready ? 'Serving as one offer. The head sees prompts; the others only receive tensors.' : 'Paused: a machine is in use, offline or outside its hours.';
    const stop = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-stop'), ' Stop pool'], { type: 'button' });
    stop.addEventListener('click', async () => {
        stop.disabled = true;
        try {
            await apiFetch(`/api/v1/machine-pools/${encodeURIComponent(pool.id)}/revoke`, { method: 'POST', body: '{}' });
            mcSay('The pool is stopped. Each machine drops its private link and key at its next check.');
            loadMachines();
        } catch (e) { mcSay(e.message || 'The pool could not be stopped.', true); stop.disabled = false; }
    });
    block.append(mcEl('p', 'mc-confirm', [note]), mcEl('div', 'mc-acts', [stop]));
    return block;
}

/** "Pool these machines": one picker per local network with two or more of your machines that checked in lately. */
function mcPoolPickers(candidates) {
    const groups = new Map();
    for (const c of candidates) {
        if (!c.network) continue;
        if (!groups.has(c.network)) groups.set(c.network, []);
        groups.get(c.network).push(c);
    }
    return [...groups.values()].filter((g) => g.length >= 2).map((group) => {
        const panel = mcEl('fieldset', 'mc-roles mc-pool mc-card', [mcEl('legend', '', ['Pool these machines'])]);
        const boxes = group.map((c) => {
            const id = `mc-pool-${c.id}`;
            const box = mcEl('input', '', [], { type: 'checkbox', id, value: c.id });
            panel.append(mcEl('label', 'mc-role', [box, mcEl('span', 'mc-role-ic', [mcIcon('fa-microchip')]), mcEl('span', 'mc-role-t', [
                mcEl('b', '', [mcName(c.id)]), mcEl('small', '', [`${mcGB(c.free_vram)} free VRAM · ${mcGB(c.free_ram)} free RAM · ${c.hardware}`])])], { for: id }));
            return box;
        });
        const head = mcEl('select', 'mc-rename', [mcEl('option', '', ['Head: the most free VRAM'], { value: '' })], { 'aria-label': 'Which machine is the head' });
        group.forEach((c) => head.append(mcEl('option', '', [`Head: ${mcName(c.id)}`], { value: c.id })));
        const create = mcEl('button', 'btn btn-outline btn-small', [mcIcon('fa-layer-group'), ' Pool them'], { type: 'button' });
        create.addEventListener('click', async () => {
            const machines = boxes.filter((b) => b.checked).map((b) => b.value);
            if (machines.length < 2) { mcSay('Choose at least two machines.', true); return; }
            create.disabled = true;
            try {
                await apiFetch('/api/v1/machine-pools', { method: 'POST', body: JSON.stringify({ machines, ...(head.value ? { head: head.value } : {}) }) });
                mcSay('Pool proposed. Approve it on each machine; Node measures the links before it serves.');
                loadMachines();
            } catch (e) { mcSay(e.message || 'The pool could not be made.', true); create.disabled = false; }
        });
        panel.append(mcEl('p', 'mc-confirm', ['These machines checked in from the same local network. The head runs the model and sees prompts; the others lend their memory and only receive tensors. One price for the pool, and credits split by the VRAM each machine serves.']),
            mcEl('div', 'mc-acts', [head, create]));
        return panel;
    });
}
