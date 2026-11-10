import { locker } from '/locker.mjs';

// Link Send from the browser: the page seals the item for one of the person's own machines with Locker, then uploads
// the ciphertext in parts so a dropped connection resumes instead of starting again. The relay never sees a key. The
// list below the form reads the page's own outbox, so the person can see whether the machine accepted or saved it.
const CHUNK = 1024 * 1024;

const form = document.querySelector('[data-link-send]');
if (form) {
    const select = form.elements.machine;
    const status = form.querySelector('[data-send-status]');
    const progress = form.querySelector('[data-send-progress]');
    const delivery = document.querySelector('[data-send-delivery]');
    const say = (text) => { status.textContent = text; };
    const signedOut = 'Sign in on openvibe.link to choose one of your machines.';

    function bytesToBase64(bytes) {
        let out = '';
        for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(out);
    }

    async function machines() {
        // Signed out, there is nothing to list: ask the session first instead of letting the keys read fail (a 401 in
        // every signed-out visitor's console, 11-09 sweep).
        const me = await fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store' }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        if (!me || !me.user) throw new Error(signedOut);
        const r = await fetch('/api/v1/me/nodes/send-keys', { credentials: 'same-origin', cache: 'no-store' });
        if (r.status === 401 || r.status === 403) throw new Error(signedOut);
        if (!r.ok) throw new Error('Your machines could not be loaded.');
        const body = await r.json();
        select.replaceChildren(new Option('Choose a machine', ''));
        for (const m of body.machines || []) {
            if (!m.public_key) continue;
            select.add(new Option(`${m.name}${m.online ? '' : ' (offline)'}`, m.id));
        }
        if (select.options.length === 1) say('Pair a machine and open Link once to turn on receiving.');
    }

    async function packageContent(file, text) {
        const name = file ? file.name : 'note.txt';
        const mime = file ? (file.type || 'application/octet-stream') : 'text/plain;charset=utf-8';
        const data = file ? new Uint8Array(await file.arrayBuffer()) : new TextEncoder().encode(text);
        const meta = new TextEncoder().encode(JSON.stringify({ name, mime }));
        const out = new Uint8Array(4 + meta.length + data.length);
        new DataView(out.buffer).setUint32(0, meta.length);
        out.set(meta, 4); out.set(data, 4 + meta.length);
        return out;
    }

    async function jsonOrProblem(response, missing) {
        if (response.ok) return response.status === 204 ? null : response.json().catch(() => ({}));
        const body = await response.json().catch(() => ({}));
        const error = new Error(body.detail || missing || 'Link could not send this item.');
        error.status = response.status;
        throw error;
    }

    async function startUpload(targetId, bytes) {
        const r = await fetch('/api/v1/me/nodes/send/upload', {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_node: targetId, bytes }),
        });
        return jsonOrProblem(r, 'Your machine could not start receiving this item.');
    }

    async function uploadStatus(id) {
        const r = await fetch(`/api/v1/me/nodes/send/upload/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' });
        return jsonOrProblem(r, 'This transfer is no longer waiting.');
    }

    async function putPart(id, seq, chunk) {
        const r = await fetch(`/api/v1/me/nodes/send/upload/${encodeURIComponent(id)}/${seq}`, {
            method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chunk }),
        });
        return jsonOrProblem(r, 'A part of the encrypted item was refused.');
    }

    async function finishUpload(id) {
        const r = await fetch(`/api/v1/me/nodes/send/upload/${encodeURIComponent(id)}/finish`, {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        return jsonOrProblem(r, 'Your machine could not confirm the item.');
    }

    function drawProgress(sent, total) {
        if (!progress) return;
        progress.hidden = false;
        progress.max = 100;
        progress.value = total ? Math.min(100, Math.round((sent / total) * 100)) : 0;
    }

    async function sendEncrypted(targetId, envelope) {
        const bytes = envelope.length;
        let upload = await startUpload(targetId, bytes);
        let seq = Number(upload.seq) || 0;
        let attempts = 0;
        while (seq * CHUNK < envelope.length) {
            const chunk = envelope.slice(seq * CHUNK, (seq + 1) * CHUNK);
            try {
                const answer = await putPart(upload.id, seq, chunk);
                seq = Number(answer.seq) || seq + 1;
                attempts = 0;
                drawProgress(Math.min(bytes, seq * CHUNK), bytes);
            } catch (error) {
                // A dropped connection is not a lost transfer: ask the relay which part it has and continue there.
                attempts += 1;
                if (attempts > 5) throw new Error('The connection kept dropping. Your machine did not receive this item; try again.');
                say('The connection dropped. Continuing where it stopped…');
                try {
                    const answer = await uploadStatus(upload.id);
                    seq = Number(answer.seq) || seq;
                } catch { seq = Math.max(0, seq - 1); }
            }
        }
        let done = await finishUpload(upload.id);
        for (let i = 0; i < 3 && !done?.id; i++) done = await finishUpload(upload.id).catch(() => null);
        if (!done?.id) throw new Error('Your machine could not confirm the item. The relay kept the encrypted parts for an hour.');
        drawProgress(bytes, bytes);
        return done;
    }

    async function sendPayload(file, text) {
        const machine = select.value;
        if (!machine) return say('Choose one of your machines.');
        if (!file && !text.trim()) return say('Choose a file or write a note.');
        if (file && file.size > 20 * 1024 * 1024) return say('Choose a file smaller than 20 MB for now.');
        const button = form.querySelector('button[type="submit"]');
        if (button) button.disabled = true;
        try {
            say('Encrypting in this browser…');
            const listed = await fetch('/api/v1/me/nodes/send-keys', { credentials: 'same-origin', cache: 'no-store' });
            const target = (await jsonOrProblem(listed, signedOut)).machines.find((m) => m.id === machine && m.public_key);
            if (!target) throw new Error('That machine has no receive key yet. Open Link on it and try again.');
            const payload = await packageContent(file, text);
            const sealed = await locker.seal(payload, { lock: 'people', keys: [{ subject: { type: 'link', id: target.id }, publicKey: target.public_key }] });
            say('Sending encrypted data…');
            drawProgress(0, 1);
            await sendEncrypted(target.id, bytesToBase64(sealed.bytes));
            say('Sent. The receiving machine will ask before saving it.');
            form.elements.file.value = ''; form.elements.text.value = '';
            if (progress) { progress.value = 100; setTimeout(() => { progress.hidden = true; }, 2500); }
            await loadDelivery();
        } catch (e) {
            say(e.message || 'Link could not send this item.');
            if (progress) progress.hidden = true;
        } finally {
            if (button) button.disabled = false;
        }
    }

    function deliveryLine(item) {
        const name = item.target_name || 'your machine';
        const size = Number(item.bytes) || 0;
        const words = {
            pending: `Waiting for ${name} to accept`,
            accepted: `${name} accepted it; it is saving it now`,
            saved: `Saved on ${name}`,
            declined: `${name} declined it`,
            expired: `Link removed it after 24 hours; ${name} did not accept it`,
        };
        return `${words[item.state] || words.pending} · ${size < 1048576 ? Math.max(1, Math.round(size / 1024)) + ' KB' : (size / 1048576).toFixed(1) + ' MB'}`;
    }

    async function loadDelivery() {
        if (!delivery) return;
        try {
            const r = await fetch('/api/v1/me/nodes/send', { credentials: 'same-origin', cache: 'no-store' });
            if (r.status === 401 || r.status === 403) return;
            if (!r.ok) return;
            const body = await r.json();
            const items = Array.isArray(body.items) ? body.items : [];
            delivery.replaceChildren(...items.slice(0, 10).map((item) => {
                const li = document.createElement('li');
                const when = item.created_at ? new Date(item.created_at).toLocaleString() : '';
                li.textContent = `${deliveryLine(item)}${when ? ' · ' + when : ''}`;
                return li;
            }));
            if (!items.length) {
                const li = document.createElement('li');
                li.textContent = 'Nothing sent from this page yet.';
                delivery.replaceChildren(li);
            }
        } catch { /* the list is informational; the send itself reported its own failure */ }
    }

    machines().catch((e) => { select.replaceChildren(new Option('Sign in to load machines', '')); say(e.message); });
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        sendPayload(form.elements.file.files[0], form.elements.text.value);
    });
    loadDelivery();
    setInterval(loadDelivery, 5000);
}
