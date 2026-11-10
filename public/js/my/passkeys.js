async function loadPasskeySettings() {
    const root = document.getElementById('passkey-settings');
    if (!root || isAnonSession() || !window.PublicKeyCredential) return;
    try {
        const state = await apiFetch('/api/auth/passkeys');
        if (!state.available && !state.keys.length) return;
        root.hidden = false;
        root.innerHTML = '<h3>Passkeys</h3><p role="status"></p><form><label>Current password <input name="password" type="password" autocomplete="current-password" required></label><label>Authenticator or recovery code <input name="code" autocomplete="one-time-code"></label><button type="button" data-verify class="ovk-btn ovk-btn--quiet">Verify with a passkey</button><label>Passkey name <input name="name" maxlength="80"></label><button type="submit" class="ovk-btn ovk-btn--primary">Add passkey</button></form><div data-keys></div>';
        const status = root.querySelector('[role="status"]');
        const form = root.querySelector('form');
        let proof;
        const call = (path, body) => apiFetch('/api/auth/passkeys/' + path, { method: 'POST', body: JSON.stringify(body) });
        const credentials = () => ({ password: form.elements.password.value, code: form.elements.code.value, proof });
        const clear = () => { proof = undefined; form.elements.password.value = ''; form.elements.code.value = ''; };
        root.querySelector('[data-verify]').onclick = async () => {
            try { proof = (await networkPasskeys.authenticate(call, 'reauth')).proof; status.textContent = 'Passkey verified for one change.'; }
            catch (err) { status.textContent = err.message; }
        };
        form.querySelector('[type="submit"]').hidden = !state.available;
        form.onsubmit = async e => {
            e.preventDefault(); const button = form.querySelector('[type="submit"]'); button.disabled = true;
            try {
                const result = await networkPasskeys.register(call, credentials(), form.elements.name.value);
                await loadPasskeySettings();
                if (result.recovery_codes.length) {
                    const codes = document.createElement('pre'); codes.textContent = result.recovery_codes.join('\n');
                    const note = document.createElement('p'); note.textContent = 'Save these recovery codes now. Each works once; they will not be shown again.';
                    root.append(note, codes);
                }
            } catch (err) { status.textContent = err.message; }
            finally { clear(); button.disabled = false; }
        };
        for (const key of state.keys) {
            const row = document.createElement('p');
            row.textContent = key.name + ' — ' + (key.backed_up ? 'Synced' : 'Device') + ' — Last used: ' + (key.last_used_at ? new Date(Number(key.last_used_at)).toLocaleString() : 'Never') + ' ';
            const remove = document.createElement('button'); remove.className = 'ovk-btn ovk-btn--quiet'; remove.textContent = 'Remove';
            remove.onclick = async () => {
                remove.disabled = true;
                try { await call('remove', { ...credentials(), id: key.id }); await loadPasskeySettings(); }
                catch (err) { status.textContent = err.message; }
                finally { clear(); remove.disabled = false; }
            };
            row.append(remove); root.querySelector('[data-keys]').append(row);
        }
    } catch { /* An unavailable pilot never interrupts the account hub. */ }
}
