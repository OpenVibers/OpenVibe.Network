/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): domains, SSH access and the deploy tab.
   Split out of admin.html. Classic scripts, global scope: they rely on
   admin/core.js's helpers (api, esc, toast, API, token) and on the
   tabLoaders map in admin/boot.js (loaded last). No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// ── Tool domains (owner only; the server enforces it) ───────────────
let _domCatalog = null;
async function loadDomains() {
    const el = document.getElementById('domains-content');
    try {
        const [list, cat] = await Promise.all([api('/api/admin/domains'), _domCatalog ? Promise.resolve(_domCatalog) : api('/api/admin/domains/catalog')]);
        _domCatalog = cat;
        const byTool = {}; list.domains.forEach(d => { (byTool[d.tool_id] = byTool[d.tool_id] || []).push(d); });
        const opts = [...cat.families.map(f => ({ id: f.id, name: f.name + ' (family)' })), ...cat.tools.map(t => ({ id: t.id, name: t.name }))];
        const roleBadge = r => `<span class="badge ${r === 'canonical' ? 'badge-success' : r === 'short' ? 'badge-info' : ''}">${esc(r)}</span>`;
        el.innerHTML = `
        <div class="card"><h3><i class="fa-solid fa-globe"></i> Tool domains</h3>
            <p class="muted">Every tool has a <b>canonical</b> host (used in links, sitemaps and canonical tags), a <b>short</b> host people type, any number of <b>aliases</b> that redirect to the short one, and <b>mirrors</b> that serve the tool on another address while pointing search engines at the canonical host. Custom domains work the same way: point DNS at the server, add the host here, then run <code>add-custom-domain.sh</code> on the host for nginx and TLS. Tools picks changes up within a minute.${cat.source !== 'live' ? ' <br><span class="badge badge-warning">Tools catalog unreachable: showing the built-in list</span>' : ''}</p>
            <div class="form-group" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;align-items:end">
                <div class="form-field"><label for="dom-tool">Tool</label><select id="dom-tool">${opts.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select></div>
                <div class="form-field"><label for="dom-host">Host</label><input id="dom-host" placeholder="youtubedownloadonline.com" autocomplete="off" spellcheck="false"></div>
                <div class="form-field"><label for="dom-role">Role</label><select id="dom-role"><option value="alias">alias (redirects to the short host)</option><option value="mirror">mirror (serves the tool, canonical tag points at the SEO host)</option><option value="short">short (what people type)</option><option value="canonical">canonical (SEO host)</option></select></div>
                <div class="form-field"><label for="dom-note">Note</label><input id="dom-note" maxlength="500"></div>
                <div><button class="btn btn-outline" onclick="checkDomainDns()">Check DNS</button> <button class="btn btn-primary" onclick="addDomain()">Add</button></div>
            </div>
            <div id="dom-check" class="muted" style="margin-top:8px"></div>
        </div>
        <div class="card"><h3>Overrides</h3>
            ${list.domains.length ? `<div style="overflow-x:auto"><table class="table" style="width:100%"><thead><tr><th>Tool</th><th>Host</th><th>Role</th><th>On</th><th>Note</th><th></th></tr></thead><tbody>
            ${list.domains.map(d => `<tr><td>${esc(d.tool_id)}${d.tool_known === false ? ' <span class="badge badge-warning">unknown tool</span>' : ''}</td>
                <td><a href="https://${esc(d.host)}/" target="_blank" rel="noopener">${esc(d.host)}</a></td><td>${roleBadge(d.role)}</td>
                <td><input type="checkbox" ${d.enabled ? 'checked' : ''} onchange="updateDomain(${d.id},{enabled:this.checked})" aria-label="Enabled"></td>
                <td>${esc(d.note || '')}</td>
                <td style="white-space:nowrap"><select onchange="updateDomain(${d.id},{role:this.value})" aria-label="Role">${['canonical','short','alias','mirror'].map(r => `<option ${r === d.role ? 'selected' : ''}>${r}</option>`).join('')}</select>
                    <button class="btn btn-sm btn-danger" onclick="deleteDomain(${d.id},'${esc(d.host)}')">Remove</button></td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">No overrides yet. Every tool is using its built-in hosts.</p>'}
        </div>
        <div class="card"><h3>Built-in hosts</h3><div style="overflow-x:auto"><table class="table" style="width:100%"><thead><tr><th>Tool</th><th>Canonical</th><th>Short</th><th>Aliases</th></tr></thead><tbody>
            ${cat.tools.map(t => `<tr><td>${esc(t.name)} <small class="muted">${esc(t.id)}</small></td><td>${esc(t.hosts?.canonical || '')}</td><td>${esc(t.hosts?.short || '')}</td><td>${esc((t.hosts?.aliases || []).join(', '))}</td></tr>`).join('')}
        </tbody></table></div></div>`;
    } catch (e) { el.innerHTML = `<div class="card"><p class="muted">Could not load domains: ${esc(e.message)}</p></div>`; }
}
async function addDomain() {
    const body = { tool_id: document.getElementById('dom-tool').value, host: document.getElementById('dom-host').value, role: document.getElementById('dom-role').value, note: document.getElementById('dom-note').value };
    try { const r = await api('/api/admin/domains', { method: 'POST', body }); toast('Domain added', 'success'); (r.warnings || []).forEach(w => toast(w, 'warning')); loadDomains(); } catch (e) { toast(e.message, 'error'); }
}
async function updateDomain(id, patch) { try { const r = await api('/api/admin/domains/' + id, { method: 'PUT', body: patch }); (r.warnings || []).forEach(w => toast(w, 'warning')); toast('Saved', 'success'); } catch (e) { toast(e.message, 'error'); } loadDomains(); }
async function deleteDomain(id, host) { if (!confirm(`Remove ${host}?`)) return; try { await api('/api/admin/domains/' + id, { method: 'DELETE' }); toast('Removed', 'success'); } catch (e) { toast(e.message, 'error'); } loadDomains(); }
async function checkDomainDns() {
    const out = document.getElementById('dom-check'); out.textContent = 'Checking…';
    try { const r = await api('/api/admin/domains/check', { method: 'POST', body: { host: document.getElementById('dom-host').value } }); const c = r.check || {};
        out.textContent = (c.status === 'ready' ? 'Ready. ' : '') + (c.message || c.status || ''); } catch (e) { out.textContent = e.message; }
}

// ═══════════════════════════════════════════════════════════════
// SSH Access — owner provisions locked-down dev accounts; admins get
// guided instructions + an agent prompt to connect and vibe-code.
// ═══════════════════════════════════════════════════════════════
let sshInfo = null;

async function loadSSH() {
    const el = document.getElementById('ssh-content');
    if (!el) return;
    if (!sshInfo) {
        try {
            const r = await fetch(`${API}/api/admin/ssh-info`, { headers: authHeaders() });
            const d = await r.json();
            if (!d.ok) throw new Error(d.error || 'Failed to load SSH info');
            sshInfo = d;
        } catch (e) {
            el.innerHTML = `<div class="card"><p class="muted">Could not load SSH info: ${esc(e.message)}</p></div>`;
            return;
        }
    }
    if (sshInfo.is_owner) renderSSHOwner(el);
    else renderSSHUser(el);
}

function _sshSetText(id, t) { const e = document.getElementById(id); if (e) e.textContent = t; }
function _sshSanitizeUser(v) { return (v || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''); }

function sshCopy(id, btn) {
    const el = document.getElementById(id);
    if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(() => {
        if (typeof toast === 'function') toast('Prompt copied', 'success');
        if (btn) { const o = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied'; setTimeout(() => { btn.innerHTML = o; }, 1400); }
    }).catch(() => { if (typeof toast === 'function') toast('Copy failed', 'error'); });
}

// ── Owner view ──────────────────────────────────────────────
function renderSSHOwner(el) {
    const hostWarn = sshInfo.host ? '' :
        `<div class="card" style="border-color:var(--warning)"><p style="color:var(--warning);margin:0"><i class="fa-solid fa-triangle-exclamation"></i> No server host is configured yet. Set <code>SSH_SERVER_HOST</code> in the openvibe-network environment so the connection details fill in automatically.</p></div>`;
    el.innerHTML = `
    <div class="card">
        <h3><i class="fa-solid fa-user-lock"></i> Provision an SSH dev account <span class="staff-pill">Owner</span></h3>
        <p class="muted">Create a locked-down Linux account so a trusted admin can SSH in and help build the sites (vibe coding with Claude). They get their own home + group access to the project folders — <b>no root</b>. Fill in the fields, copy the prompt, and hand it to your agent.</p>
    </div>
    ${hostWarn}
    <div class="card">
        <div class="form-group" style="margin-bottom:14px">
            <label>New Linux username</label>
            <input type="text" id="ssh-o-user" placeholder="e.g. alex" oninput="sshOwnerUpdate()" style="max-width:280px">
        </div>
        <div class="form-group" style="margin-bottom:14px">
            <label>Their SSH <b>public</b> key <span class="muted">— ask them to run the steps in their own SSH tab and paste their <code>.pub</code> here (recommended)</span></label>
            <textarea id="ssh-o-pubkey" rows="3" placeholder="ssh-ed25519 AAAA... alex@openvibe" oninput="sshOwnerUpdate()" style="width:100%;font-family:ui-monospace,monospace;font-size:0.82rem"></textarea>
        </div>
        <div class="form-group">
            <label>Access level</label>
            <select id="ssh-o-access" onchange="sshOwnerUpdate()" style="max-width:440px">
                <option value="code">Project code only (safest)</option>
                <option value="restart">Project code + restart app services</option>
                <option value="web">Full web + nginx — build &amp; run their own sites (high trust)</option>
            </select>
        </div>
        <div id="ssh-o-webwarn" style="display:none;margin-top:12px;padding:10px 12px;border:1px solid var(--warning);border-radius:8px;background:color-mix(in srgb,var(--warning) 10%,transparent);color:var(--warning);font-size:0.84rem;line-height:1.5">
            <i class="fa-solid fa-triangle-exclamation"></i> <b>High trust:</b> web + nginx access lets this admin edit any nginx site config and reload the web server — they can serve anything and a bad config can take <em>all</em> the sites down. It still stops short of root (no package installs or arbitrary sudo), but only grant it to admins you fully trust to run the web layer with you.
        </div>
    </div>
    <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <h3 style="margin:0"><i class="fa-solid fa-robot"></i> Agent prompt</h3>
            <button class="btn btn-primary" onclick="sshCopy('ssh-o-prompt', this)"><i class="fa-solid fa-copy"></i> Copy Prompt</button>
        </div>
        <p class="muted" style="margin:8px 0">Paste into Claude Code running on the server with sudo (or locally with root SSH) to create and lock down the account.</p>
        <pre id="ssh-o-prompt" class="ssh-prompt"></pre>
    </div>
    <div class="card">
        <h3><i class="fa-solid fa-shield-halved"></i> How it's locked down</h3>
        <ul class="muted" style="line-height:1.7;margin:0;padding-left:20px">
            <li>Key-only login — password auth is disabled for the account.</li>
            <li>Member of a shared <code>devs</code> group that owns the project dirs (<code>${esc(sshInfo.projectsRoot)}</code>) with setgid, so they can edit code and new files stay group-shared.</li>
            <li><b>Not</b> in <code>sudo</code> — no blanket root. TLS / packages / arbitrary system changes stay with you.</li>
            <li><b>Access levels</b> are additive and each grants only a tightly-scoped sudoers rule (never general root):
                <ul style="margin:4px 0 0;padding-left:18px">
                    <li><b>Project code only</b> — edit code in the project dirs, nothing privileged.</li>
                    <li><b>+ Restart app services</b> — adds sudo for <code>systemctl restart openvibe-network/openvibe-live</code> only.</li>
                    <li><b>Full web + nginx</b> — adds group ownership of the nginx site configs + a <code>/srv/www</code> web root, plus sudo limited to <code>nginx -t</code> and reload/restart of nginx &amp; php-fpm. Lets them build &amp; run their own sites — high trust, since a bad config affects every site.</li>
                </ul>
            </li>
            <li>Revoke anytime: remove their key from <code>~/.ssh/authorized_keys</code>, or <code>sudo deluser --remove-home &lt;user&gt;</code>.</li>
        </ul>
    </div>`;
    sshOwnerUpdate();
}

function sshOwnerUpdate() {
    const user = _sshSanitizeUser(document.getElementById('ssh-o-user')?.value) || '<username>';
    const pub = (document.getElementById('ssh-o-pubkey')?.value || '').trim();
    const access = document.getElementById('ssh-o-access')?.value || 'code';
    const host = sshInfo.host || '<server-host>';
    const roots = sshInfo.projectsRoot;
    const firstRoot = roots.split(/\s+/)[0];
    const pubShown = pub || "<PASTE THE USER'S SSH PUBLIC KEY HERE>";
    const isRestart = access === 'restart' || access === 'web';
    const isWeb = access === 'web';

    // Toggle the high-trust warning under the selector.
    const ww = document.getElementById('ssh-o-webwarn');
    if (ww) ww.style.display = isWeb ? 'block' : 'none';

    const steps = [
        `Create the user with no password login:\n   sudo adduser --disabled-password --gecos "" ${user}`,
        `Install their SSH public key:\n   sudo install -d -m 700 -o ${user} -g ${user} /home/${user}/.ssh\n   echo "${pubShown}" | sudo tee /home/${user}/.ssh/authorized_keys\n   sudo chmod 600 /home/${user}/.ssh/authorized_keys\n   sudo chown ${user}:${user} /home/${user}/.ssh/authorized_keys`,
        `Create/ensure a shared dev group and add them:\n   sudo groupadd -f devs\n   sudo usermod -aG devs ${user}`,
        `Give the group access to the project dirs (setgid so new files stay shared):\n   sudo chgrp -R devs ${roots}\n   sudo chmod -R g+rwX ${roots}\n   sudo find ${roots} -type d -exec chmod g+s {} +`,
        `Do NOT add them to the sudo group — they must not have blanket root.`,
    ];
    if (isWeb) {
        steps.push(`Grant broad web + nginx access (edit any site config, run their own sites):\n   sudo groupadd -f webdev\n   sudo usermod -aG webdev ${user}\n   # let the group own & edit nginx site configs (setgid keeps new files group-shared)\n   sudo chgrp -R webdev /etc/nginx/sites-available /etc/nginx/sites-enabled\n   sudo chmod -R g+rwX /etc/nginx/sites-available /etc/nginx/sites-enabled\n   sudo find /etc/nginx/sites-available /etc/nginx/sites-enabled -type d -exec chmod g+s {} +\n   # a shared web root for their own sites (2775 = group-writable + setgid)\n   sudo install -d -m 2775 -o root -g webdev /srv/www`);
    }
    if (isRestart) {
        const cmds = ['/usr/bin/systemctl restart openvibe-network', '/usr/bin/systemctl restart openvibe-live'];
        if (isWeb) cmds.push('/usr/sbin/nginx -t', '/usr/bin/systemctl reload nginx', '/usr/bin/systemctl restart nginx', '/usr/bin/systemctl reload php*-fpm', '/usr/bin/systemctl restart php*-fpm');
        steps.push(`Allow ONLY these exact root commands via sudo (nothing else):\n   echo '${user} ALL=(root) NOPASSWD: ${cmds.join(', ')}' | sudo tee /etc/sudoers.d/${user}\n   sudo chmod 440 /etc/sudoers.d/${user}\n   sudo visudo -c`);
    }
    steps.push(`Verify:\n   sudo -u ${user} whoami\n   sudo -u ${user} ls -la ${firstRoot}${isWeb ? '\n   sudo -u ' + user + ' test -w /etc/nginx/sites-enabled && echo "nginx: writable"' : ''}`);
    const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n\n');

    const purpose = isWeb
        ? 'help develop our sites AND build/run their own nginx + PHP sites on the box'
        : 'help develop the sites';
    const webNote = isWeb
        ? '\n\nNote: this tier gives them full control of the web layer (nginx configs + a /srv/www web root + reloading nginx/php-fpm) but still NOT blanket root — installing new system packages (PHP runtime, etc.) stays an owner action. If PHP-FPM is not installed yet, install it once before they start.'
        : '';

    const prompt =
`You are provisioning a locked-down SSH account on my Linux server for a trusted OpenVibe admin so they can SSH in and ${purpose} (vibe coding with Claude Code). Be careful and idempotent, and do NOT grant this user root/sudo beyond exactly what is specified below.

Server host: ${host}
New username: ${user}
Their SSH public key:
${pubShown}

Steps:
${numbered}${webNote}

Finally, tell me the exact command they should run to connect:
   ssh ${user}@${host}`;
    _sshSetText('ssh-o-prompt', prompt);
}

// ── Admin (user) view ───────────────────────────────────────
function renderSSHUser(el) {
    const defUser = _sshSanitizeUser(currentUser.username) || 'me';
    el.innerHTML = `
    <div class="card">
        <h3><i class="fa-solid fa-terminal"></i> Connect to the dev server <span class="staff-pill user-pill">You</span></h3>
        <p class="muted">Generate your key, send the owner (<b>${esc(sshInfo.ownerUsername)}</b>) your <b>public</b> key to authorize, then SSH in and help build the sites with Claude. Your private key never leaves your machine.</p>
    </div>
    <div class="card">
        <div class="form-group">
            <label>Your SSH username <span class="muted">— confirm the exact name with the owner</span></label>
            <input type="text" id="ssh-u-user" value="${esc(defUser)}" oninput="sshUserUpdate()" style="max-width:280px">
        </div>
    </div>
    <div class="card">
        <h3><i class="fa-solid fa-list-ol"></i> Steps</h3>
        <ol class="muted" style="line-height:1.9;padding-left:20px;margin:0">
            <li>Generate a key pair (skip if you already have one you want to use):<br><code id="ssh-u-keygen"></code></li>
            <li>Print your <b>public</b> key and send it to the owner to authorize:<br><code id="ssh-u-cat"></code></li>
            <li>Once they confirm it's added, put this in your <code>~/.ssh/config</code>:<pre id="ssh-u-config" class="ssh-prompt" style="margin-top:6px"></pre></li>
            <li>Connect: <code id="ssh-u-connect"></code></li>
        </ol>
    </div>
    <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <h3 style="margin:0"><i class="fa-solid fa-robot"></i> Agent prompt</h3>
            <button class="btn btn-primary" onclick="sshCopy('ssh-u-prompt', this)"><i class="fa-solid fa-copy"></i> Copy Prompt</button>
        </div>
        <p class="muted" style="margin:8px 0">Paste into Claude Code on your own machine — it sets up the connection and gives it full context about the server so you can start vibe coding.</p>
        <pre id="ssh-u-prompt" class="ssh-prompt"></pre>
    </div>`;
    sshUserUpdate();
}

function sshUserUpdate() {
    const host = sshInfo.host || '<server-host>';
    const user = _sshSanitizeUser(document.getElementById('ssh-u-user')?.value) || '<username>';
    const keygen = `ssh-keygen -t ed25519 -C "${user}@openvibe" -f ~/.ssh/openvibe_${user}`;
    const cat = `cat ~/.ssh/openvibe_${user}.pub`;
    const config = `Host openvibe\n    HostName ${host}\n    User ${user}\n    IdentityFile ~/.ssh/openvibe_${user}\n    ServerAliveInterval 60`;
    const connect = `ssh openvibe`;
    _sshSetText('ssh-u-keygen', keygen);
    _sshSetText('ssh-u-cat', cat);
    _sshSetText('ssh-u-config', config);
    _sshSetText('ssh-u-connect', connect);

    const prompt =
`Help me connect to the OpenVibe dev server over SSH, then help me develop the sites (vibe coding with Claude Code).

My SSH username: ${user}
Server host: ${host}

Do this:
1. If I don't already have this key, generate one (leave the passphrase empty, or set one — my call):
   ${keygen}
2. Print my PUBLIC key so I can send it to the server owner (${sshInfo.ownerUsername}) to authorize. Nothing works until they add it:
   ${cat}
3. Add this block to my ~/.ssh/config (create the file if needed, then chmod 600 ~/.ssh/config):
${config}
4. Test the connection:
   ${connect}

Context about the server so you can help me once I'm connected:
- Projects live under: ${sshInfo.projectsRoot}
  (openvibe.network under /opt/openvibe.network, OpenVibe.Live under /opt/openvibe.live)
- Services are systemd units: ${sshInfo.services.join(', ')}. Deploys are git-based —
  cd into the project, git pull --ff-only, then restart the service (if I'm permitted).
- I'm a OpenVibe admin, not root. nginx / TLS / packages / system-level changes go through the owner.
- Other devs share the project group, so be careful with shared files and always pull before editing.
Once I'm connected, cd into the relevant project and let's build.`;
    _sshSetText('ssh-u-prompt', prompt);
}

// ═══════════════════════════════════════════════════════════════
// Deploy Panel — TLS / Nginx / Infrastructure Control Plane
// ═══════════════════════════════════════════════════════════════

function showDeploySubTab(tab, btn) {
    deployCurrentSubTab = tab;
    document.querySelectorAll('#deploy-sub-tabs button').forEach(b => b.classList.remove('active'));
    (btn || _subBtn('deploy-sub-tabs', tab))?.classList.add('active');
    ['deploy-overview', 'deploy-certs-panel', 'deploy-nginx-panel', 'deploy-domains-panel', 'deploy-config-panel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const map = {
        overview: 'deploy-overview',
        certs: 'deploy-certs-panel',
        nginx: 'deploy-nginx-panel',
        domains: 'deploy-domains-panel',
        config: 'deploy-config-panel',
    };
    const target = document.getElementById(map[tab]);
    if (target) target.style.display = 'block';
    if (tab === 'overview') loadDeployOverview();
    if (tab === 'certs') loadDeployCerts();
    if (tab === 'domains') loadDeployDomains();
    if (tab === 'config') loadDeployConfig();
    _syncAdminUrl();
}

async function loadDeployOverview() {
    try {
        const r = await fetch(`${API}/api/admin/deploy/prerequisites`, { headers: authHeaders() });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        const p = d.prerequisites;
        const c = d.config;
        document.getElementById('deploy-stats').innerHTML = `
            <div class="stat-card"><div class="value" style="color:${p.certbotInstalled ? 'var(--success)' : 'var(--danger)'}"><i class="fa-solid fa-${p.certbotInstalled ? 'check' : 'xmark'}"></i></div><div class="label">Certbot</div></div>
            <div class="stat-card"><div class="value" style="color:${p.cloudflarePluginInstalled ? 'var(--success)' : 'var(--warning)'}"><i class="fa-solid fa-${p.cloudflarePluginInstalled ? 'check' : 'minus'}"></i></div><div class="label">CF Plugin</div></div>
            <div class="stat-card"><div class="value" style="color:${p.nginxInstalled ? 'var(--success)' : 'var(--danger)'}"><i class="fa-solid fa-${p.nginxInstalled ? 'check' : 'xmark'}"></i></div><div class="label">Nginx</div></div>
            <div class="stat-card"><div class="value" style="color:${c.hasCloudflareToken ? 'var(--success)' : 'var(--text-muted)'}"><i class="fa-solid fa-${c.hasCloudflareToken ? 'check' : 'minus'}"></i></div><div class="label">CF Token</div></div>
            <div class="stat-card"><div class="value">${c.domainsConfigured}</div><div class="label">Domains</div></div>
            <div class="stat-card"><div class="value" style="font-size:14px">${esc(c.certMode)}</div><div class="label">Cert Mode</div></div>
            <div class="stat-card"><div class="value" style="font-size:14px">${esc(c.nginxMode)}</div><div class="label">Nginx Mode</div></div>
        `;
        const prereqsEl = document.getElementById('deploy-prereqs');
        const items = [];
        items.push(prereqLine('Certbot installed', p.certbotInstalled));
        items.push(prereqLine('Cloudflare DNS plugin', p.cloudflarePluginInstalled, 'Optional — needed for automated DNS-01'));
        items.push(prereqLine('Let\'s Encrypt dir writable', p.letsencryptDirWritable, 'Run as root or with sudo'));
        items.push(prereqLine('Nginx installed', p.nginxInstalled));
        items.push(prereqLine('Cloudflare INI exists', p.cloudflareIniExists, 'Auto-created when token is saved'));
        items.push(prereqLine('ACME email configured', !!c.acmeEmail, c.acmeEmail || 'Not set'));
        prereqsEl.innerHTML = items.join('');
    } catch (e) {
        document.getElementById('deploy-stats').innerHTML = `<div class="muted" style="color:var(--danger)">${esc(e.message)}</div>`;
    }
}

function prereqLine(label, ok, detail) {
    const icon = ok ? '<i class="fa-solid fa-circle-check" style="color:var(--success)"></i>' : '<i class="fa-solid fa-circle-xmark" style="color:var(--danger)"></i>';
    const detailHtml = detail ? ` <span class="muted" style="font-size:11px">— ${esc(detail)}</span>` : '';
    return `<div style="padding:6px 0;display:flex;align-items:center;gap:8px">${icon} ${esc(label)}${detailHtml}</div>`;
}

async function loadDeployCerts() {
    const el = document.getElementById('deploy-certs-list');
    try {
        const r = await fetch(`${API}/api/admin/deploy/certs`, { headers: authHeaders() });
        const d = await r.json();
        if (!d.ok && d.error) throw new Error(d.error);
        if (!d.certs || d.certs.length === 0) {
            el.innerHTML = '<div class="muted">No certificates found. Issue your first certificate below.</div>';
            return;
        }
        el.innerHTML = d.certs.map(c => {
            const isWild = c.domains?.some(d => d.startsWith('*.'));
            const expColor = (c.daysRemaining || 0) < 14 ? 'var(--danger)' : (c.daysRemaining || 0) < 30 ? 'var(--warning)' : 'var(--success)';
            return `<div class="card" style="margin-bottom:8px;padding:12px">
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
                    <div>
                        <strong>${esc(c.name)}</strong>
                        ${isWild ? '<span style="font-size:10px;background:var(--accent);color:#000;padding:1px 6px;border-radius:3px;margin-left:6px">WILDCARD</span>' : ''}
                        <div class="muted" style="font-size:11px;margin-top:2px">${(c.domains || []).map(d => esc(d)).join(', ')}</div>
                    </div>
                    <div style="text-align:right">
                        <span style="color:${expColor};font-weight:600">${c.daysRemaining != null ? c.daysRemaining + ' days' : 'Unknown'}</span>
                        <div class="muted" style="font-size:11px">${c.expiry ? 'Expires ' + esc(c.expiry) : ''}</div>
                    </div>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        el.innerHTML = `<div class="muted" style="color:var(--danger)">${esc(e.message)}</div>`;
    }
}

async function issueCertCloudflare() {
    const domain = document.getElementById('cert-issue-domain').value.trim();
    if (!domain) return alert('Enter a domain');
    const out = document.getElementById('cert-issue-output');
    out.innerHTML = '<div class="loading">Issuing wildcard certificate via Cloudflare DNS... This may take 30-60 seconds.</div>';
    try {
        const r = await fetch(`${API}/api/admin/deploy/certs/issue-cloudflare`, {
            method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain }),
        });
        const d = await r.json();
        if (d.ok) {
            out.innerHTML = `<div style="color:var(--success);padding:8px"><i class="fa-solid fa-check-circle"></i> Certificate issued: ${esc(d.certName || domain)}</div>
                <pre style="background:var(--bg-input);padding:8px;border-radius:6px;font-size:11px;max-height:200px;overflow:auto;margin-top:8px">${esc(d.output || '')}</pre>`;
            loadDeployCerts();
        } else {
            out.innerHTML = `<div style="color:var(--danger);padding:8px"><i class="fa-solid fa-xmark"></i> ${esc(d.error || 'Failed')}</div>
                <pre style="background:var(--bg-input);padding:8px;border-radius:6px;font-size:11px;max-height:200px;overflow:auto;margin-top:8px">${esc(d.output || '')}</pre>`;
        }
    } catch (e) {
        out.innerHTML = `<div style="color:var(--danger)">${esc(e.message)}</div>`;
    }
}

async function showManualDnsInfo() {
    const domain = document.getElementById('cert-issue-domain').value.trim();
    if (!domain) return alert('Enter a domain');
    const out = document.getElementById('cert-issue-output');
    out.innerHTML = '<div class="loading">Getting manual DNS challenge info...</div>';
    try {
        const r = await fetch(`${API}/api/admin/deploy/certs/manual-info`, {
            method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain }),
        });
        const d = await r.json();
        const instructions = (d.instructions || []).map(i => esc(i)).join('<br>');
        out.innerHTML = `<div class="card" style="padding:16px;margin-top:8px">
            <h4 style="margin-bottom:8px"><i class="fa-solid fa-hand"></i> Manual DNS Challenge</h4>
            <div style="font-size:13px;line-height:1.6">${instructions}</div>
            <div style="margin-top:16px">
                <button class="btn btn-primary" onclick="issueManualCert('${esc(domain)}')">
                    <i class="fa-solid fa-certificate"></i> DNS Records Created — Issue Certificate
                </button>
                <div class="muted" style="font-size:11px;margin-top:4px">Only click after creating the required DNS TXT records</div>
            </div>
        </div>`;
    } catch (e) {
        out.innerHTML = `<div style="color:var(--danger)">${esc(e.message)}</div>`;
    }
}

async function issueManualCert(domain) {
    const out = document.getElementById('cert-issue-output');
    out.innerHTML = '<div class="loading">Issuing certificate with manual DNS verification... This may take 30-60 seconds.</div>';
    try {
        const r = await fetch(`${API}/api/admin/deploy/certs/issue-manual`, {
            method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain }),
        });
        const d = await r.json();
        if (d.ok) {
            out.innerHTML = `<div style="color:var(--success);padding:8px"><i class="fa-solid fa-check-circle"></i> Certificate issued: ${esc(d.certName || domain)}</div>
                <pre style="background:var(--bg-input);padding:8px;border-radius:6px;font-size:11px;max-height:200px;overflow:auto;margin-top:8px">${esc(d.output || '')}</pre>`;
            loadDeployCerts();
        } else {
            out.innerHTML = `<div style="color:var(--danger);padding:8px"><i class="fa-solid fa-xmark"></i> ${esc(d.error || 'Failed')}</div>
                <pre style="background:var(--bg-input);padding:8px;border-radius:6px;font-size:11px;max-height:200px;overflow:auto;margin-top:8px">${esc(d.output || '')}</pre>`;
        }
    } catch (e) {
        out.innerHTML = `<div style="color:var(--danger)">${esc(e.message)}</div>`;
    }
}

async function renewAllCerts() {
    const out = document.getElementById('cert-issue-output');
    out.innerHTML = '<div class="loading">Renewing all certificates...</div>';
    try {
        const r = await fetch(`${API}/api/admin/deploy/certs/renew`, {
            method: 'POST', headers: authHeaders(),
        });
        const d = await r.json();
        out.innerHTML = `<div style="color:${d.ok ? 'var(--success)' : 'var(--danger)'};padding:8px">
            <i class="fa-solid fa-${d.ok ? 'check-circle' : 'xmark'}"></i> ${d.ok ? 'Renewal complete' : esc(d.error || 'Failed')}
        </div>
        <pre style="background:var(--bg-input);padding:8px;border-radius:6px;font-size:11px;max-height:200px;overflow:auto;margin-top:8px">${esc(d.output || '')}</pre>`;
        if (d.ok) loadDeployCerts();
    } catch (e) {
        out.innerHTML = `<div style="color:var(--danger)">${esc(e.message)}</div>`;
    }
}

async function previewNginxConfigs() {
    const out = document.getElementById('nginx-preview-output');
    out.innerHTML = '<div class="loading">Generating Nginx configs...</div>';
    try {
        const r = await fetch(`${API}/api/admin/deploy/nginx/preview`, { headers: authHeaders() });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        out.innerHTML = d.configs.map(c => `
            <div class="card" style="margin-bottom:12px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                    <h4>${esc(c.serviceId)} <span class="muted" style="font-size:11px">${esc(c.filename)}</span></h4>
                    <span style="font-size:11px;color:${c.certFound ? 'var(--success)' : 'var(--warning)'}">${c.certFound ? '✓ cert found' : '⚠ no cert'}</span>
                </div>
                <pre style="background:var(--bg-input);padding:12px;border-radius:6px;font-size:11px;max-height:300px;overflow:auto;white-space:pre-wrap">${esc(c.content)}</pre>
            </div>
        `).join('');
    } catch (e) {
        out.innerHTML = `<div style="color:var(--danger)">${esc(e.message)}</div>`;
    }
}

async function validateNginx() {
    const out = document.getElementById('nginx-preview-output');
    out.innerHTML = '<div class="loading">Validating Nginx config...</div>';
    try {
        const r = await fetch(`${API}/api/admin/deploy/nginx/validate`, {
            method: 'POST', headers: authHeaders(),
        });
        const d = await r.json();
        out.innerHTML = `<div class="card" style="padding:16px">
            <div style="color:${d.ok ? 'var(--success)' : 'var(--danger)'}">
                <i class="fa-solid fa-${d.ok ? 'check-circle' : 'times-circle'}"></i>
                <strong>${d.ok ? 'Configuration valid' : 'Validation failed'}</strong>
            </div>
            <pre style="background:var(--bg-input);padding:8px;border-radius:6px;font-size:11px;margin-top:8px;max-height:200px;overflow:auto">${esc(d.output || '')}</pre>
        </div>`;
    } catch (e) {
        out.innerHTML = `<div style="color:var(--danger)">${esc(e.message)}</div>`;
    }
}

async function applyNginxConfigs() {
    if (!confirm('Apply generated Nginx configs? This will backup existing configs, write new ones, validate, and reload Nginx.')) return;
    const out = document.getElementById('nginx-preview-output');
    out.innerHTML = '<div class="loading">Applying Nginx configs...</div>';
    try {
        const r = await fetch(`${API}/api/admin/deploy/nginx/apply`, {
            method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ reload: true }),
        });
        const d = await r.json();
        const lines = [];
        lines.push(`<div style="color:${d.ok ? 'var(--success)' : 'var(--danger)'}"><i class="fa-solid fa-${d.ok ? 'check-circle' : 'times-circle'}"></i> <strong>${d.ok ? 'Applied successfully' : 'Apply failed'}</strong></div>`);
        if (d.dryRun) lines.push('<div class="muted">Dry run — no files were written</div>');
        if (d.applied?.length) lines.push(`<div>Applied: ${d.applied.map(f => esc(f)).join(', ')}</div>`);
        if (d.backed_up?.length) lines.push(`<div class="muted">Backed up: ${d.backed_up.length} files</div>`);
        if (d.validation) lines.push(`<div>Validation: ${d.validation.ok ? '✓ passed' : '✗ failed'}</div>`);
        if (d.reload) lines.push(`<div>Reload: ${d.reload.ok ? '✓ success' : '✗ failed'}</div>`);
        if (d.errors?.length) lines.push(`<div style="color:var(--danger)">Errors: ${d.errors.map(e => esc(e)).join('; ')}</div>`);
        out.innerHTML = `<div class="card" style="padding:16px">${lines.join('')}</div>`;
    } catch (e) {
        out.innerHTML = `<div style="color:var(--danger)">${esc(e.message)}</div>`;
    }
}

let deployDomainsList = [];

async function loadDeployDomains() {
    const el = document.getElementById('deploy-domains-list');
    try {
        const r = await fetch(`${API}/api/admin/deploy/domains`, { headers: authHeaders() });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        deployDomainsList = d.domains || [];
        if (deployDomainsList.length === 0) {
            el.innerHTML = '<div class="muted">No domains configured. Add your first domain below.</div>';
            return;
        }
        el.innerHTML = deployDomainsList.map((d, i) => `
            <div class="card" style="margin-bottom:6px;padding:10px;display:flex;justify-content:space-between;align-items:center">
                <div>
                    <strong>${esc(d.domain)}</strong>
                    ${d.wildcard ? '<span style="font-size:10px;background:var(--accent);color:#000;padding:1px 6px;border-radius:3px;margin-left:6px">WILDCARD</span>' : ''}
                    <span class="muted" style="font-size:11px;margin-left:8px">${d.certExists ? '🔒 cert found' : '⚠ no cert'}</span>
                    ${d.certName ? '<span class="muted" style="font-size:11px;margin-left:4px">(' + esc(d.certName) + ')</span>' : ''}
                </div>
                <button class="btn btn-danger btn-sm" onclick="removeManagedDomain(${i})" title="Remove">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `).join('');
    } catch (e) {
        el.innerHTML = `<div class="muted" style="color:var(--danger)">${esc(e.message)}</div>`;
    }
}

async function addManagedDomain() {
    const domain = document.getElementById('domain-add-input').value.trim().toLowerCase();
    if (!domain) return;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return alert('Invalid domain format');
    if (deployDomainsList.find(d => d.domain === domain)) return alert('Domain already added');
    const wildcard = document.getElementById('domain-add-wildcard').checked;
    deployDomainsList.push({ domain, wildcard, certName: domain, services: [] });
    await saveDomainsList();
    document.getElementById('domain-add-input').value = '';
}

async function removeManagedDomain(idx) {
    if (!confirm('Remove domain ' + deployDomainsList[idx]?.domain + '?')) return;
    deployDomainsList.splice(idx, 1);
    await saveDomainsList();
}

async function saveDomainsList() {
    try {
        const r = await fetch(`${API}/api/admin/deploy/domains`, {
            method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ domains: deployDomainsList }),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        loadDeployDomains();
    } catch (e) {
        alert('Failed to save: ' + e.message);
    }
}

async function loadDeployConfig() {
    try {
        const r = await fetch(`${API}/api/admin/deploy/config`, { headers: authHeaders() });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        document.getElementById('deploy-acme-email').value = d.config.acmeEmail || '';
        document.getElementById('deploy-cert-mode').value = d.config.certMode || 'manual';
        document.getElementById('deploy-cf-token').value = d.config.cloudflareToken || '';
        document.getElementById('deploy-nginx-mode').value = d.config.nginxMode || 'preview';
        document.getElementById('deploy-nginx-path').value = d.config.nginxSitesPath || '/etc/nginx/sites-enabled';
    } catch (e) {
        document.getElementById('deploy-config-status').innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
    }
}

async function saveDeployConfig() {
    const status = document.getElementById('deploy-config-status');
    try {
        const body = {
            acmeEmail: document.getElementById('deploy-acme-email').value.trim(),
            certMode: document.getElementById('deploy-cert-mode').value,
            cloudflareToken: document.getElementById('deploy-cf-token').value,
            nginxMode: document.getElementById('deploy-nginx-mode').value,
            nginxSitesPath: document.getElementById('deploy-nginx-path').value.trim(),
        };
        const r = await fetch(`${API}/api/admin/deploy/config`, {
            method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        status.innerHTML = '<span style="color:var(--success)"><i class="fa-solid fa-check"></i> Saved</span>';
        setTimeout(() => status.innerHTML = '', 3000);
    } catch (e) {
        status.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
    }
}
