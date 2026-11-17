/* ════════════════════════════════════════════════════
   OpenVibe.Network — admin panel: the Hosting tab (plan §AD.18; the owner, 2026-11-17: "Output a plan for the new
   hosting setup to the admin panel"). What runs today, the recommendation, the phases and the prices compared, from
   GET /api/admin/hosting-plan (server/admin/hosting-plan.js). Classic script; uses core.js's api() and esc().
   ════════════════════════════════════════════════════ */
async function loadHosting() {
    const c = document.getElementById('hosting-content');
    if (!c) return;
    let p;
    try { p = await api('/api/admin/hosting-plan'); } catch (err) { c.textContent = 'Could not load the plan: ' + err.message; return; }
    const link = (src, text) => (src ? `<a href="${esc(src)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text));
    const table = (cols, rows) => `<div class="hp-table-wrap"><table class="admin-table hp-table"><thead><tr>${cols.map(([, h]) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${cols.map(([k]) => `<td>${k === 'src' ? link(r.src, r.read ? `source, ${r.read}` : 'source') : esc(r[k] == null ? '—' : r[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    c.innerHTML = `
<p class="admin-intro">Checked ${esc(p.checked)}. Prices are what each source said on its date; a provider's own configurator is the price that counts before ordering.</p>
<h3 class="hp-h"><i class="fa-solid fa-server" aria-hidden="true"></i> Today</h3>
<p class="hp-lede">${esc(p.now.provider)}, ${esc(p.now.region)}.</p>
<div class="hp-facts">${p.now.facts.map((f) => `<div class="stat-card hp-fact"><b>${esc(f.value)}</b><span>${esc(f.label)}</span><small>${esc(f.note)}</small></div>`).join('')}</div>
<ul class="hp-incidents">${p.now.incidents.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h3 class="hp-h"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> ${esc(p.recommendation.title)}</h3>
<ul class="hp-rec">${p.recommendation.lines.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h3 class="hp-h"><i class="fa-solid fa-layer-group" aria-hidden="true"></i> The phases</h3>
<div class="hp-phases">${p.phases.map((ph, i) => `<section class="card hp-phase"><div class="hp-phase-head"><span class="hp-n">${i + 1}</span><b>${esc(ph.title)}</b><span class="hp-cost">${esc(ph.cost)}</span></div>
<p class="hp-when"><b>When:</b> ${esc(ph.when)}. ${esc(ph.trigger)}</p><ol>${ph.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
<p class="hp-owner"><i class="fa-solid fa-user" aria-hidden="true"></i> The owner: ${esc(ph.owner)}</p></section>`).join('')}</div>
<h3 class="hp-h"><i class="fa-solid fa-microchip" aria-hidden="true"></i> Servers compared (monthly, before tax)</h3>
${table([['provider', 'Provider'], ['plan', 'Plan'], ['spec', 'What you get'], ['price', 'Price'], ['traffic', 'Traffic'], ['regions', 'Regions'], ['note', 'Note'], ['src', 'Source']], p.compute)}
<h3 class="hp-h"><i class="fa-solid fa-database" aria-hidden="true"></i> The database: self-hosted or managed</h3>
${table([['option', 'Option'], ['price', 'Price (monthly)'], ['storage', 'Storage'], ['pitr', 'Backups / PITR'], ['pooling', 'Pooling'], ['src', 'Source']], p.database)}
<h3 class="hp-h"><i class="fa-solid fa-hard-drive" aria-hidden="true"></i> Video and file storage</h3>
${table([['option', 'Option'], ['price', 'Stored'], ['egress', 'Egress'], ['note', 'Note'], ['src', 'Source']], p.storage)}
<h3 class="hp-h"><i class="fa-solid fa-diagram-project" aria-hidden="true"></i> Running many servers</h3>
${table([['option', 'Option'], ['cost', 'Cost'], ['upkeep', 'Upkeep'], ['note', 'Note'], ['src', 'Source']], p.orchestration)}
<div class="card hp-needs"><b><i class="fa-solid fa-hand" aria-hidden="true"></i> Needs the owner</b><ul>${p.owner.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
}
