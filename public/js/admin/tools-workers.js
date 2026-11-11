/* Owner-only Tools infrastructure controls. Credentials stay in this response/DOM only. */
async function loadToolsWorkers() {
    if (!currentUser || !currentUser.is_owner) return;
    const parent = document.getElementById('settings-tools');
    let panel = document.getElementById('tools-workers-panel');
    if (!panel) { panel = document.createElement('section'); panel.id = 'tools-workers-panel'; parent.appendChild(panel); }
    panel.innerHTML = '<h2>Tools workers</h2><p>Loading workers…</p>';
    try {
        const fleet = await api('/api/admin/tools-workers/fleet');
        const value = n => n == null ? '—' : esc(Number(n).toLocaleString());
        panel.innerHTML = `<h2>Tools workers</h2>
<p><a href="https://openvibe.tools/workers" target="_blank" rel="noopener">Run Tools on your own machine</a>. Jobs today counts execution attempts in UTC and survives job expiry. Load is the one-minute system load.</p>
<div style="overflow-x:auto"><table><thead><tr><th>Worker / location</th><th>Status</th><th>Load</th><th>Free / slots</th><th>Active jobs</th><th>Jobs today (${esc(fleet.day)})</th><th>Controls</th></tr></thead><tbody>
${fleet.workers.map(w => `<tr><td>${esc(w.label)}<br><code>${esc(w.id)}</code><br>${esc(w.location)}</td><td>${w.revoked ? 'Revoked' : !w.online ? 'Offline' : w.draining ? 'Draining' : 'Online'}</td><td>${w.load == null ? '—' : esc(Number(w.load).toFixed(2))}</td><td>${value(w.free)} / ${value(w.slots)}</td><td>${value(w.active_jobs)}</td><td>${value(w.jobs_today)}</td><td>${w.id === 'host' ? 'Fallback' : w.revoked ? '' : `<button class="ovk-btn ovk-btn--quiet" data-worker-drain="${esc(w.id)}" data-draining="${w.draining ? 'false' : 'true'}">${w.draining ? 'Resume' : 'Drain'}</button> <button class="ovk-btn ovk-btn--quiet" data-worker-revoke="${esc(w.id)}">Revoke credential</button>`}</td></tr>`).join('')}
</tbody></table></div>
<button type="button" class="ovk-btn ovk-btn--quiet" id="tools-workers-refresh">Refresh workers</button>
<form id="tools-workers-routing"><h3>Routing</h3><label><input type="checkbox" id="tools-workers-enabled" ${fleet.routing.enabled ? 'checked' : ''}> Enable worker routing</label><p><label for="tools-workers-order">Order (home, host, or worker ids; separated by commas)</label><br><textarea id="tools-workers-order" rows="3">${esc(fleet.routing.order.join(', '))}</textarea></p><p>Within each group, free slots and recent latency decide. Fetching jobs stay on the host. Draining stops new assignments and lets current jobs finish.</p><button class="ovk-btn ovk-btn--primary" type="submit">Save routing</button></form>
<form id="tools-workers-create"><h3>Add a worker</h3><label>Label <input name="label" required maxlength="80" pattern="[A-Za-z0-9_ .-]+" placeholder="Dell tower one"></label> <label>Location <select name="location"><option value="home">Home</option><option value="host">Host</option></select></label> <button class="ovk-btn ovk-btn--primary" type="submit">Create one-time credential</button></form>
<div id="tools-workers-credential" hidden><p>Save this token in a private file on the worker. It is shown only now and cannot be retrieved again.</p><pre id="tools-workers-token"></pre><button type="button" class="ovk-btn ovk-btn--quiet" id="tools-workers-clear">Clear credential</button></div>
<p id="tools-workers-status" role="status"></p>`;
        const status = message => { panel.querySelector('#tools-workers-status').textContent = message; };
        const action = async (button, fn) => { button.disabled = true; try { await fn(); } catch (e) { status(e.message); } finally { button.disabled = false; } };
        panel.querySelector('#tools-workers-refresh').onclick = () => loadToolsWorkers();
        panel.querySelector('#tools-workers-clear').onclick = () => { panel.querySelector('#tools-workers-token').textContent = ''; panel.querySelector('#tools-workers-credential').hidden = true; };
        for (const button of panel.querySelectorAll('[data-worker-drain]')) button.onclick = () => action(button, async () => {
            await api(`/api/admin/tools-workers/workers/${button.dataset.workerDrain}/drain`, { method: 'PUT', body: { draining: button.dataset.draining === 'true' } });
            await loadToolsWorkers();
        });
        for (const button of panel.querySelectorAll('[data-worker-revoke]')) button.onclick = () => action(button, async () => {
            await api(`/api/admin/tools-workers/workers/${button.dataset.workerRevoke}`, { method: 'DELETE' });
            await loadToolsWorkers();
        });
        panel.querySelector('#tools-workers-routing').onsubmit = event => {
            event.preventDefault();
            return action(event.target.querySelector('button'), async () => {
                const order = panel.querySelector('#tools-workers-order').value.split(/[\s,]+/).filter(Boolean);
                await api('/api/admin/tools-workers/routing', { method: 'PUT', body: { enabled: panel.querySelector('#tools-workers-enabled').checked, order } });
                await loadToolsWorkers();
            });
        };
        panel.querySelector('#tools-workers-create').onsubmit = event => {
            event.preventDefault();
            return action(event.target.querySelector('button'), async () => {
                const fields = new FormData(event.target);
                const credential = await api('/api/admin/tools-workers/workers', { method: 'POST', body: { label: fields.get('label'), location: fields.get('location') } });
                // Render immediately: a later fleet fetch must not lose the one-time response.
                panel.querySelector('#tools-workers-token').textContent = `Worker id: ${credential.id}\nToken: ${credential.token}`;
                panel.querySelector('#tools-workers-credential').hidden = false;
                status('Worker created. Save the credential before refreshing.');
                event.target.reset();
            });
        };
    } catch (e) { panel.innerHTML = `<h2>Tools workers</h2><p>${esc(e.message)}</p><button class="ovk-btn ovk-btn--quiet" type="button" onclick="loadToolsWorkers()">Retry</button>`; }
}
