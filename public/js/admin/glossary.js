/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin): the glossary (/admin#glossary).
   The few words the panel cannot avoid, each in plain words (OWNER-SETUP-AND-ADMIN-CLARITY-DESIGN, 2026-11-07,
   rule 9). A small "What does this mean?" link next to a word opens its line in place; the whole list is the
   Glossary tab. Classic script, global scope: it relies on admin/core.js's esc() and is loaded before ai.js and
   setup.js. No ES modules.
   ═══════════════════════════════════════════════════════════════ */
const GLOSSARY = [
    { id: 'credits', word: 'Credits', text: 'What people spend on AI at OpenVibe. People buy them with money, a request uses some, and what a request costs depends on the model. Credits are kept by OpenVibe.Billing, not by the AI providers.' },
    { id: 'byok', word: 'Their own key (BYOK)', text: '"Bring your own key": a person enters their own key for a provider, and their requests are paid by that key instead of by OpenVibe or by Credits.' },
    { id: 'resale', word: 'Resale', text: 'Letting people use a provider\'s models through OpenVibe and pay OpenVibe for it. Some providers\' terms forbid this; a provider whose terms are not checked yet is treated as "Do not sell".' },
    { id: 'cache', word: 'Cache', text: 'A saved copy of an earlier answer or of the start of a long prompt. Reading from the cache is cheaper and faster than asking again, so providers price it lower.' },
    { id: 'quota', word: 'Quota', text: 'A limit on how much someone may use in a period, for example requests per day. When it is reached, more requests wait or are refused until the period ends.' },
    { id: 'workflow', word: 'Workflow (saved AI task)', text: 'A saved AI task with its steps and settings, which other parts of OpenVibe run by name. A prompt template is the text it starts from; a routing rule decides which model answers.' },
    { id: 'lock-key', word: 'Lock key', text: 'The key a service locks every stored key with (its "KEK", in the server\'s settings file). Without it, keys are stored unlocked. Nobody can read a locked key back, not even the owner.' },
    { id: 'settings-file', word: 'Server\'s settings file', text: 'The private file on the server that holds a service\'s settings (its env file). A setting it holds wins over what is entered here, and can only be changed on the server.' },
    { id: 'fresh-sign-in', word: 'Confirm it\'s you', text: 'Changing a key or a money setting needs a sign-in from the last ten minutes. If yours is older, OpenVibe asks for your password again and brings you back.' },
    { id: 'health', word: 'Health (paused provider)', text: 'After several errors in a row OpenVibe pauses a provider for a short while and uses the next one, then tries it again. "Paused" is that wait; "Testing again" is the first try after it.' },
    { id: 'tokens', word: 'Million words (tokens)', text: 'Providers price text per million tokens; a token is about three quarters of a word. "Read" (input) is what is sent to the model, "written" (output) is what it answers.' },
    { id: 'version', word: 'Saved version', text: 'Every change to a group of settings is kept as a numbered version, with who made it and why. History shows them; Roll back makes an older one current again, as a new version.' },
    { id: 'setup-states', word: 'Needed, Not working, Connected, Optional', text: 'On Setup: Needed means something waits on it; Not working means it is set but its last test failed; Connected means it is set and not failing; Optional means nothing waits on it.' },
];

function glossaryEntry(id) {
    return GLOSSARY.find((g) => g.id === id) || null;
}

/** The small "What does this mean?" link next to a word. Opens the line in place; a new tab opens the full list. */
function glossaryLink(id, label) {
    if (!glossaryEntry(id)) return '';
    return '<a class="ov-what" href="#" role="button" data-glossary="' + esc(id) + '">' + esc(label || 'What does this mean?') + '</a>';
}

function glossaryPopup(id, anchor) {
    const entry = glossaryEntry(id);
    if (!entry) return;
    const dlg = document.createElement('dialog');
    dlg.className = 'pai-dialog ov-what-dialog';
    const form = document.createElement('div');
    form.className = 'pai-form';
    const h = document.createElement('h3');
    h.textContent = entry.word;
    const p = document.createElement('p');
    p.className = 'ov-what-text';
    p.textContent = entry.text;
    const actions = document.createElement('div');
    actions.className = 'pai-dialog-actions';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn-primary';
    close.textContent = 'Close';
    close.addEventListener('click', () => dlg.close());
    actions.append(close);
    form.append(h, p, actions);
    dlg.append(form);
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => { dlg.remove(); if (anchor && anchor.focus) anchor.focus(); });
    dlg.showModal();
}

/** Scroll the list to one word and mark it for a moment (the list must already be drawn). */
// One listener for every "What does this mean?" link on the page, wherever it was drawn.
document.addEventListener('click', (ev) => {
    const link = ev.target.closest && ev.target.closest('a[data-glossary]');
    if (!link || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    glossaryPopup(link.dataset.glossary, link);
});
