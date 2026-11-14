/* ═══════════════════════════════════════════════════════════════
   OpenVibe Network admin: the Domains tab (owner only; the server enforces it). Classic deferred script in global
   scope: it relies on admin/core.js's helpers (api, esc, toast) and on the tabLoaders map in admin/boot.js (loaded
   last). It lived in deploy.js until #904 deleted that file with the Deploy and SSH tabs (2026-11-13), which left
   boot.js naming loadDomains with nothing behind it: the whole panel stopped at "Loading stats...".
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
        const roleBadge = r => `<span class="badge ${r === 'canonical' ? 'badge-success' : r === 'short' ? 'badge-info' : ''}">${esc({canonical:"Main address for search engines",short:"Short public address",alias:"Redirect to the short address",mirror:"Additional address serving the tool"}[r] || adminWords(r))}</span>`;
        el.innerHTML = `
        <div class="card"><h3><i class="fa-solid fa-globe"></i> Tool domains</h3>
            <p class="muted">Every tool has a <b>canonical</b> host (used in links, sitemaps and canonical tags), a <b>short</b> host people type, any number of <b>aliases</b> that redirect to the short one, and <b>mirrors</b> that serve the tool on another address while pointing search engines at the canonical host. Custom domains work the same way: point DNS at the server, add the host here, then run <code>add-custom-domain.sh</code> on the host for nginx and TLS. Tools picks changes up within a minute.${cat.source !== 'live' ? ' <br><span class="badge badge-warning">Tools catalog unreachable: showing the built-in list</span>' : ''}</p>
            <div class="form-group" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;align-items:end">
                <div class="form-field"><label for="dom-tool">Tool</label><select id="dom-tool" aria-label="Tool receiving this address" aria-describedby="help-dom-tool">${opts.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select><span class="admin-help" id="help-dom-tool">Choose the tool or family that should open at the domain. The first catalog item is selected initially; choose the intended tool before adding the host.</span></div>
                <div class="form-field"><label for="dom-host">Host</label><input id="dom-host" aria-label="Website hostname" aria-describedby="help-dom-host" placeholder="youtubedownloadonline.com" autocomplete="off" spellcheck="false"><span class="admin-help" id="help-dom-host">No hostname is entered by default. Enter a hostname without https://, for example tools.example.com, after pointing its DNS at the server.</span></div>
                <div class="form-field"><label for="dom-role">Role</label><select id="dom-role" aria-label="How this address works" aria-describedby="help-dom-role"><option value="alias">Redirect — sends visitors to the short address</option><option value="mirror">Mirror — serves the tool here, and points search engines at the main address</option><option value="short">Short — the address people type</option><option value="canonical">Main — the address search engines are pointed at</option></select><span class="admin-help" id="help-dom-role">Redirect is the default and sends visitors to the short address. Mirror serves the tool at this address, Short sets its public address, and Main sets its preferred search-engine address.</span></div>
                <div class="form-field"><label for="dom-note">Note</label><input id="dom-note" aria-label="Staff note" aria-describedby="help-dom-note" maxlength="500"><span class="admin-help" id="help-dom-note">Optional note, blank by default. For example: campaign domain for November.</span></div>
                <div><button class="btn btn-outline" onclick="checkDomainDns()"><i class="fa-solid fa-shield-halved"></i> Check DNS</button> <button class="btn btn-primary" onclick="addDomain()"><i class="fa-solid fa-plus"></i> Add</button></div>
            </div>
            <div id="dom-check" class="muted" style="margin-top:8px"></div>
        </div>
        <div class="card"><h3>Overrides</h3><p class="admin-intro">These saved addresses replace or extend the built-in tool addresses. Change them when routing a custom domain; delete the override to return to built-in routing.</p>
            ${list.domains.length ? `<div style="overflow-x:auto"><table class="table" style="width:100%"><thead><tr><th>Tool</th><th>Host</th><th>Role</th><th>On</th><th>Note</th><th></th></tr></thead><tbody>
            ${list.domains.map(d => `<tr><td>${esc(d.tool_id)}${d.tool_known === false ? ' <span class="badge badge-warning">unknown tool</span>' : ''}</td>
                <td><a href="https://${esc(d.host)}/" target="_blank" rel="noopener">${esc(d.host)}</a></td><td>${roleBadge(d.role)}</td>
                <td><input type="checkbox" ${d.enabled ? 'checked' : ''} onchange="updateDomain(${d.id},{enabled:this.checked})" aria-label="Enabled"></td>
                <td>${esc(d.note || '')}</td>
                <td style="white-space:nowrap"><select onchange="updateDomain(${d.id},{role:this.value})" aria-label="Role">${['canonical','short','alias','mirror'].map(r => `<option value="${r}" ${r === d.role ? 'selected' : ''}>${{canonical:'Main address for search engines',short:'Short public address',alias:'Redirect to the short address',mirror:'Additional address serving the tool'}[r]}</option>`).join('')}</select>
                    <button class="btn btn-sm btn-danger" onclick="deleteDomain(${d.id},'${esc(d.host)}')"><i class="fa-solid fa-trash"></i> Remove override</button></td></tr>`).join('')}
            </tbody></table></div>` : '<p class="muted">No overrides yet; tools use their built-in addresses. Add a domain above when you need a custom address.</p>'}
        </div>
        <div class="card"><h3>Built-in hosts</h3><p class="admin-intro">These are the default addresses supplied by the tool catalog. Check them before adding an override so you know which address it replaces.</p><div style="overflow-x:auto"><table class="table" style="width:100%"><thead><tr><th>Tool</th><th>Canonical</th><th>Short</th><th>Aliases</th></tr></thead><tbody>
            ${cat.tools.map(t => `<tr><td>${esc(t.name)} <small class="muted">${esc(t.id)}</small></td><td>${esc(t.hosts?.canonical || '')}</td><td>${esc(t.hosts?.short || '')}</td><td>${esc((t.hosts?.aliases || []).join(', '))}</td></tr>`).join('')}
        </tbody></table></div></div>`;
    } catch (e) { el.innerHTML = `<div class="card"><p class="muted">Could not load domains: ${esc(e.message)}</p></div>`; }
}
async function addDomain() {
    const body = { tool_id: document.getElementById('dom-tool').value, host: document.getElementById('dom-host').value, role: document.getElementById('dom-role').value, note: document.getElementById('dom-note').value };
    try { const r = await api('/api/admin/domains', { method: 'POST', body }); toast('Domain added', 'success'); (r.warnings || []).forEach(w => toast(w, 'warning')); loadDomains(); } catch (e) { toast(e.message, 'error'); }
}
async function updateDomain(id, patch) { try { const r = await api('/api/admin/domains/' + id, { method: 'PUT', body: patch }); (r.warnings || []).forEach(w => toast(w, 'warning')); toast('Saved', 'success'); } catch (e) { toast(e.message, 'error'); } loadDomains(); }
async function deleteDomain(id, host) { if (!confirm(`Remove ${host} from the tool address overrides? This changes routing after refresh. Add the same host and role again to undo.`)) return; try { await api('/api/admin/domains/' + id, { method: 'DELETE' }); toast('Removed', 'success'); } catch (e) { toast(e.message, 'error'); } loadDomains(); }
async function checkDomainDns() {
    const out = document.getElementById('dom-check'); out.textContent = 'Checking…';
    try { const r = await api('/api/admin/domains/check', { method: 'POST', body: { host: document.getElementById('dom-host').value } }); const c = r.check || {};
        out.textContent = (c.status === 'ready' ? 'Ready. ' : '') + (c.message || c.status || ''); } catch (e) { out.textContent = e.message; }
}
