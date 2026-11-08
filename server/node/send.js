import { locker } from '/locker.mjs';

const form = document.querySelector('[data-link-send]');
if (form) {
    const select = form.elements.machine;
    const status = form.querySelector('[data-send-status]');
    const say = (text) => { status.textContent = text; };
    const machines = async () => {
        const r = await fetch('/api/v1/me/nodes/send-keys', { credentials: 'same-origin', cache: 'no-store' });
        if (r.status === 401 || r.status === 403) throw new Error('Sign in on openvibe.link to choose one of your machines.');
        if (!r.ok) throw new Error('Your machines could not be loaded.');
        const body = await r.json();
        select.replaceChildren(new Option('Choose a machine', ''));
        for (const m of body.machines || []) {
            if (!m.public_key) continue;
            select.add(new Option(`${m.name}${m.online ? '' : ' (offline)'}`, m.id));
        }
        if (select.options.length === 1) say('Pair a machine and open Link once to turn on receiving.');
    };
    const base64 = (bytes) => {
        let out = '';
        for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(out);
    };
    async function packageContent(file, text) {
        let name, mime, data;
        if (file) { name = file.name; mime = file.type || 'application/octet-stream'; data = new Uint8Array(await file.arrayBuffer()); }
        else { name = 'note.txt'; mime = 'text/plain;charset=utf-8'; data = new TextEncoder().encode(text); }
        const meta = new TextEncoder().encode(JSON.stringify({ name, mime }));
        const out = new Uint8Array(4 + meta.length + data.length);
        new DataView(out.buffer).setUint32(0, meta.length);
        out.set(meta, 4); out.set(data, 4 + meta.length);
        return out;
    }
    machines().catch((e) => { select.replaceChildren(new Option('Sign in to load machines', '')); say(e.message); });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const machine = (form.elements.machine.value);
        const file = form.elements.file.files[0];
        const text = form.elements.text.value;
        if (!machine) return say('Choose one of your machines.');
        if (!file && !text.trim()) return say('Choose a file or write a note.');
        if (file && file.size > 20 * 1024 * 1024) return say('Choose a file smaller than 20 MB for now.');
        try {
            say('Encrypting in this browser…');
            const listed = await fetch('/api/v1/me/nodes/send-keys', { credentials: 'same-origin', cache: 'no-store' });
            if (!listed.ok) throw new Error('Sign in on openvibe.link, then try again.');
            const target = (await listed.json()).machines.find((m) => m.id === machine && m.public_key);
            if (!target) throw new Error('That machine has no receive key yet. Open Link on it and try again.');
            const payload = await packageContent(file, text);
            const sealed = await locker.seal(payload, { lock: 'people', keys: [{ subject: { type: 'node', id: target.id }, publicKey: target.public_key }] });
            say('Sending encrypted data…');
            const sent = await fetch('/api/v1/me/nodes/send', {
                method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_node: target.id, envelope: base64(sealed.bytes) }),
            });
            if (!sent.ok) {
                const detail = await sent.json().catch(() => ({}));
                throw new Error(detail.detail || 'Link could not send this item.');
            }
            say('Sent. The receiving machine will ask before saving it.');
            form.elements.file.value = ''; form.elements.text.value = '';
        } catch (e) { say(e.message || 'Link could not send this item.'); }
    });
}
