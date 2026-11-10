/* Plain account security controls; presentation belongs to the account-hub design. */
async function loadMfaSettings() {
    const root = document.getElementById('mfa-settings');
    if (!root || isAnonSession()) return;
    try {
        const state = await apiFetch('/api/auth/mfa');
        if (!state.available && !state.enabled) return;
        root.hidden = false;
        root.innerHTML = '<h3>Authenticator</h3><p role="status"></p><div data-controls></div><div data-devices></div>';
        const status = root.querySelector('[role="status"]');
        const controls = root.querySelector('[data-controls]');
        const call = (path, body) => apiFetch('/api/auth/mfa/' + path, { method: 'POST', body: JSON.stringify(body) });
        const form = (markup, action) => {
            controls.innerHTML = '<form>' + markup + '<button type="submit" class="ovk-btn ovk-btn--primary">Continue</button></form>';
            controls.firstChild.addEventListener('submit', async e => {
                e.preventDefault();
                const button = e.target.querySelector('button');
                button.disabled = true;
                try { await action(new FormData(e.target)); } catch (err) { status.textContent = err.message; }
                finally { button.disabled = false; }
            });
        };
        if (state.enabled) {
            status.textContent = 'Authenticator is enabled.';
            form('<label>Current authenticator or recovery code <input name="code" autocomplete="one-time-code" required></label><p>Continue to turn off the authenticator.</p>', async data => {
                await call('disable', { code: data.get('code') });
                await loadMfaSettings();
            });
        } else {
            form('<label>Current password <input name="password" type="password" autocomplete="current-password" required></label><label>Recovery code (if you already have a passkey) <input name="code" autocomplete="one-time-code"></label>', async data => {
                const setup = await call('enroll', { password: data.get('password'), code: data.get('code') });
                form('<p>Scan this QR in your authenticator, or enter the key.</p><img alt="Authenticator setup QR"><p><code></code></p><label>Authenticator code <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>', async data => {
                    const result = await call('confirm', { code: data.get('code') });
                    controls.textContent = '';
                    status.textContent = 'Authenticator enabled. Save these recovery codes now; each works once and they will not be shown again.';
                    const codes = document.createElement('pre');
                    codes.textContent = result.recovery_codes.join('\n');
                    controls.append(codes);
                    const done = document.createElement('button');
                    done.className = 'ovk-btn ovk-btn--quiet'; done.textContent = 'I saved my codes';
                    done.addEventListener('click', loadMfaSettings); controls.append(done);
                });
                controls.querySelector('img').src = setup.qr;
                controls.querySelector('code').textContent = setup.secret;
            });
        }
        for (const device of state.devices) {
            const row = document.createElement('p');
            row.textContent = 'Remembered browser added ' + new Date(Number(device.created_at)).toLocaleDateString() + ' ';
            const button = document.createElement('button'); button.className = 'ovk-btn ovk-btn--quiet'; button.textContent = 'Forget';
            button.addEventListener('click', async () => {
                try { await call('devices/revoke', { id: device.id }); row.remove(); } catch (err) { status.textContent = err.message; }
            });
            row.append(button); root.querySelector('[data-devices]').append(row);
        }
    } catch { /* Unavailable enrollment does not interrupt the account hub. */ }
}
