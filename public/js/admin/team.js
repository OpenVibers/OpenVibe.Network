/* ════════════════════════════════════════════════════
   OpenVibe.Network — admin panel: the Team tab (plan §AD.19; the owner, 2026-11-17: "admin and owner ranks should be
   able to use that via admin panel"). Group conversations of people and agents (Actor on any engine or harness, Codes on
   any harness), in the same session surface every site's menu opens (openvibe-shared ov-session.js, 4.302.0): a group is
   a run there, listed beside chats, tasks and coding runs. This tab mounts that surface on the Frame here and opens the
   latest group, or offers to start one. Classic script; uses core.js's api() and token.
   ════════════════════════════════════════════════════ */
let _teamSession = null;
function _teamScript(src) {
    return new Promise((resolve, reject) => {
        if (window.OpenVibeSession) return resolve();
        const s = document.createElement('script');
        s.src = src; s.defer = true; s.onload = () => resolve(); s.onerror = () => reject(new Error('The session surface did not load'));
        document.head.appendChild(s);
    });
}
async function loadTeam() {
    const c = document.getElementById('team-content');
    if (!c) return;
    if (_teamSession) { _teamSession.refresh(); return; }
    try { await _teamScript('/shared/ov-session.js'); } catch (err) { c.textContent = err.message; return; }
    c.replaceChildren();
    const host = document.createElement('div');
    host.className = 'team-host';
    c.appendChild(host);
    _teamSession = window.OpenVibeSession.mount(host, {
        base: location.origin + '/api/frame', token: () => token, sibling: (f) => '/shared/' + f,
        actor: true, codes: true, title: 'Team',
        line: 'Group conversations: people and agents in one thread. @mention an agent to ask it; agents hand work to each other.',
    });
    try {
        const j = await api('/api/frame/groups');
        const latest = j && Array.isArray(j.groups) && j.groups[0];
        if (latest) _teamSession.open('group:' + latest.id);
    } catch { /* the surface shows its own empty state and Start a group */ }
}
