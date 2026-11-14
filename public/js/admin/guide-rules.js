/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — admin panel (/admin/guide): the guided setup's rules.
   The owner, 2026-11-12: "The guided setup should be built into admin panel and walks the owner rank through full
   config of everything entirely step by step and uses recommended settings that are most intelligent for our systems."

   Pure functions over what the page reads (nothing here calls a network):
     setup     GET /api/admin/setup         every key and account only the owner can give, by group
     ai        GET /api/admin/ai/setup      every AI job: its key, model, spend and cap
     machines  GET /api/v1/machines         the owner's computers, what each can do and what is on
     access    { principal_id: settings }   each computer's access switches (GET /api/v1/me/nodes/:p/access-settings)
     progress  GET /api/admin/guide         the steps the owner skipped or saw
   build() returns the steps in order, each with its state and the setting we recommend, worked out from the live
   state: the keys that unlock the most jobs first, a cap from the real spend, each computer's roles from what it can
   actually do. "Use recommended" applies one step through the routes the rest of the admin panel already uses.
   Browser global OVGuideRules; require('…/guide-rules.js') in Node (test/admin-guide.test.js).
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
    'use strict';

    const ROLE_WORDS = { 'codes.worker': 'run your coding tasks', 'desks.host': 'give your agents a browser', 'ai.host': 'serve its AI models', 'bot.robot': 'drive a robot' };
    const SWITCH_WORDS = {
        agent_computer: 'let your agents use it', ai_models: 'let OpenVibe AI use its models', watch_probe: 'let your watches check from it',
        shared_desks: 'lend browsers to other people’s agents',
    };
    const ACCESS_WORDS = { others_may_ask: 'let people ask to use it', auto_agent_send: 'your other computers use it without asking', agents_talk: 'its agents work with other agents' };
    const ROLE_ORDER = ['codes.worker', 'desks.host', 'ai.host', 'bot.robot'];
    const SKIP_GROUPS = new Set(['ai-providers']);   // the AI steps cover them, job by job

    const money = (n) => { const v = Number(n) || 0; return v ? `$${v < 10 ? v.toFixed(2) : Math.round(v)}` : '$0'; };
    const list = (words) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);
    const arr = (v) => (Array.isArray(v) ? v : []);

    /**
     * What we recommend for one computer, from what it says it can do: a role for each thing it has (browsers for
     * agents, AI models, the Codes runner), and the switches that let those be used. A computer that keeps each
     * browser in a locked box of its own is a shared node: it lends them to other people's agents too. A robot role
     * is kept when it is on (only its owner knows a robot is plugged in). → { roles, switches, why }
     */
    function recommendMachine(m) {
        const c = (m && m.controls) || {};
        const roles = new Set(arr(m && m.roles).filter((r) => r === 'bot.robot'));
        const switches = {};
        const why = [];
        const desk = c.desk || {};
        const ai = c.ai || {};
        const fleet = arr(m && m.fleet);
        if (desk.available) { roles.add('desks.host'); why.push(`it has browsers for agents${desk.max ? ` (up to ${desk.max})` : ''}`); }
        if (ai.available && ai.models > 0) { roles.add('ai.host'); switches.ai_models = true; why.push(`it serves ${ai.models} AI model${ai.models === 1 ? '' : 's'} for free`); }
        if (fleet.length || arr(m && m.roles).includes('codes.worker')) { roles.add('codes.worker'); why.push('it runs the Codes job runner'); }
        if (c.computer) { switches.agent_computer = true; why.push(`your agents may use it as far as its own level allows${c.level ? ` (${c.level})` : ''}`); }
        if (c.computer && c.probe) switches.watch_probe = true;
        if (desk.available && desk.sandboxed) { switches.shared_desks = true; why.push('each browser is locked in its own box, so it can lend them safely'); }
        return { roles: ROLE_ORDER.filter((r) => roles.has(r)), switches, why };
    }

    /** What changes for one computer to reach the recommendation: roles to add, switches to turn on. */
    function machineChange(m) {
        const rec = recommendMachine(m);
        const have = new Set(arr(m.roles));
        const c = m.controls || {};
        const addRoles = rec.roles.filter((r) => !have.has(r));
        const turnOn = Object.keys(rec.switches).filter((k) => rec.switches[k] && c[k] !== true);
        if (!addRoles.length && !turnOn.length) return null;
        return {
            id: m.id, name: m.name || 'A computer', roles: [...new Set([...arr(m.roles), ...rec.roles])].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)),
            switches: Object.fromEntries(turnOn.map((k) => [k, true])),
            words: [...addRoles.map((r) => ROLE_WORDS[r]), ...turnOn.map((k) => SWITCH_WORDS[k])].filter(Boolean),
            why: rec.why,
        };
    }

    /** A monthly cap for one AI job: twice what it spent in the last 30 days, at least $5, in steps of $5. */
    function capFor(step) {
        const spent = Math.max(Number(step && step.estimated_month_usd) || 0, Number(step && step.month_usd) || 0);
        return Math.max(5, Math.ceil((spent * 2) / 5) * 5);
    }

    /** The providers whose keys unlock the most AI jobs, first; each with the jobs it unlocks and where to get a key. */
    function keysWanted(ai) {
        const want = new Map();
        for (const s of arr(ai && ai.steps)) {
            if (s.ready) continue;
            const rec = s.recommended || {};
            if (!rec.provider || rec.configured === true) continue;
            const w = want.get(rec.provider) || { provider: rec.provider, name: rec.provider_name || rec.provider, jobs: [], key_page: s.key_page || rec.key_page || null };
            w.jobs.push(s.short || s.name || s.id);
            want.set(rec.provider, w);
        }
        return [...want.values()].sort((a, b) => b.jobs.length - a.jobs.length || a.provider.localeCompare(b.provider));
    }

    const step = (id, area, title, plain, o = {}) => ({ id, area, title, plain, state: 'todo', recommended: null, open: null, items: [], ...o });

    /** Every step, in order, with its state and what we recommend. */
    function build({ setup = null, ai = null, machines = null, access = {}, progress = {} } = {}) {
        const skipped = new Set(arr(progress.skipped));
        const seen = new Set(arr(progress.seen));
        const steps = [];

        steps.push(step('welcome', 'Start', 'Set up OpenVibe',
            'This walks you through everything OpenVibe needs from you, one step at a time. Each step says what it does and offers the setting we recommend. You can change any of it later, and skip what you do not need yet.',
            { state: seen.has('welcome') ? 'done' : 'todo' }));

        // ── The services answer ──
        const reach = arr(setup && setup.services);
        const down = reach.filter((s) => !s.answered);
        steps.push(step('services', 'Start', 'Every service answers',
            'The guide reads each service’s settings. A service that does not answer cannot be set up from here yet.',
            {
                state: !setup ? 'unknown' : down.length ? 'needs_you' : 'done',
                // Each one with why, in plain words (11-14, the owner: "what do you mean connect? This doesn't explain").
                items: down.map((s) => ({ text: `${s.name}: its settings could not be read`, why: s.why || 'It did not answer.', state: 'bad' })),
                why: down.length ? `${reach.length - down.length} of ${reach.length} services answered. The ones below cannot be set up from here until they answer; nothing else waits on them.` : `${reach.length} services answered.`,
                reread: true,
            }));

        // ── AI: keys, models, caps, Decisions, credits ──
        const aiSteps = arr(ai && ai.steps);
        const keys = keysWanted(ai);
        steps.push(step('ai-keys', 'AI', 'Add the AI keys that unlock the most',
            'OpenVibe’s AI jobs (chat, code, pictures, speech, search …) each run on a provider. A key from a provider is what lets them run. Keys are sealed in OpenVibe.AI and never shown again.',
            {
                state: !ai ? 'unknown' : keys.length ? 'needs_you' : 'done',
                items: keys.map((k) => ({ text: `${k.name}: unlocks ${list(k.jobs)}`, href: k.key_page, state: 'todo' })),
                recommended: keys.length ? { label: `Add ${keys[0].name}’s key first`, detail: [`It unlocks ${keys[0].jobs.length} job${keys[0].jobs.length === 1 ? '' : 's'}: ${list(keys[0].jobs)}.`] } : null,
                open: { label: 'Add keys', href: '/admin/ai/setup' },
            }));

        const unrouted = aiSteps.filter((s) => s.route && !s.current && s.recommended && s.recommended.configured === true);
        steps.push(step('ai-models', 'AI', 'Pick the model for each AI job',
            'Each job uses one model. We recommend the cheapest model that does the job well, from Exchange’s catalogue and the keys you added.',
            {
                state: !ai ? 'unknown' : unrouted.length ? 'todo' : 'done',
                items: unrouted.map((s) => ({ text: `${s.name}: ${(s.recommended && (s.recommended.label || s.recommended.model)) || 'recommended'}`, state: 'todo' })),
                recommended: unrouted.length ? { label: 'Use the recommended model for every job', detail: unrouted.map((s) => `${s.name}: ${(s.recommended && (s.recommended.label || s.recommended.model)) || ''}`), apply: { type: 'ai-recommended' } } : null,
                open: { label: 'Choose by hand', href: '/admin/ai/setup' },
            }));

        const uncapped = aiSteps.filter((s) => s.route && (s.cap_usd == null || s.cap_usd === ''));
        const caps = Object.fromEntries(uncapped.map((s) => [s.id, capFor(s)]));
        steps.push(step('ai-caps', 'AI', 'Set a monthly limit for each AI job',
            'A limit stops a job from spending more than you planned in a month. We suggest twice what it spent in the last 30 days, at least $5.',
            {
                state: !ai ? 'unknown' : uncapped.length ? 'todo' : 'done',
                items: uncapped.map((s) => ({ text: `${s.name}: ${money(caps[s.id])} a month (spent ${money(s.estimated_month_usd)} in 30 days)`, state: 'todo' })),
                recommended: uncapped.length ? { label: 'Use these limits', detail: uncapped.map((s) => `${s.name}: ${money(caps[s.id])}`), apply: { type: 'ai-caps', caps } } : null,
            }));

        const decide = aiSteps.find((s) => s.id === 'decide');
        steps.push(step('decisions', 'AI', 'Decisions: quick, measured yes/no and choose-one answers',
            'Decisions answers routing, checks and grading questions with how sure it is, and it is what lets agents choose the right model and tool and measure themselves. With a Gemini key it uses Google’s calibrated Decisions model (public or test data only on Google’s free tier); without one, the cheapest structured model answers, marked not calibrated.',
            {
                state: !ai ? 'unknown' : !decide ? 'optional' : decide.ready ? 'done' : 'todo',
                recommended: decide && !decide.ready ? (decide.route && decide.current ? { label: 'Test Decisions now', apply: { type: 'ai-test', step: 'decide' } } : { label: 'Add a Gemini key, then test', detail: ['Free tier at aistudio.google.com.'] }) : null,
                open: { label: 'Open the Decisions step', href: '/admin/ai/setup' },
            }));

        steps.push(step('credits', 'AI', 'Record the credits you already get',
            'Some plans come with monthly API credits (for example ChatGPT Pro’s). Record them once, and OpenVibe spends them before it spends money.',
            { state: 'optional', open: { label: 'Open Providers on Exchange', href: 'https://openvibe.exchange/console/providers' } }));

        // ── Computers ──
        const ms = arr(machines);
        const changes = ms.map(machineChange).filter(Boolean);
        steps.push(step('machines', 'Computers', 'Put your computers to work',
            'Each computer you paired can run coding tasks, give your agents a browser and serve its own AI models. We turn on what each one can actually do.',
            {
                state: machines == null ? 'unknown' : !ms.length ? 'needs_you' : changes.length ? 'todo' : 'done',
                items: !ms.length ? [{ text: 'No computer is paired yet.', state: 'todo' }] : changes.map((ch) => ({ text: `${ch.name}: ${list(ch.words)}`, state: 'todo', why: ch.why.join('; ') })),
                recommended: changes.length ? { label: changes.length === 1 ? `Set up ${changes[0].name}` : `Set up all ${changes.length} computers`, detail: changes.map((ch) => `${ch.name}: ${list(ch.words)}`), apply: { type: 'machines', changes } } : null,
                open: { label: ms.length ? 'Open your computers' : 'Pair a computer', href: 'https://openvibe.link/machines' },
            }));

        // ── Shared nodes: access for the computers that lend their browsers ──
        const shared = ms.filter((m) => m.principal_id && (m.controls || {}).desk && m.controls.desk.sandboxed);
        const accessChanges = shared.map((m) => {
            const now = access[m.principal_id] || {};
            const off = Object.keys(ACCESS_WORDS).filter((k) => now[k] !== true);
            return off.length ? { principal: m.principal_id, id: m.id, name: m.name || 'A computer', settings: Object.fromEntries(off.map((k) => [k, true])), words: off.map((k) => ACCESS_WORDS[k]) } : null;
        }).filter(Boolean);
        steps.push(step('shared', 'Computers', 'Open your shared computers to others',
            'A shared computer serves people other than you: their agents borrow its browsers, each locked in its own box, and people can ask to use it. It never shows your files, your screen or your programs.',
            {
                state: machines == null ? 'unknown' : !shared.length ? 'optional' : accessChanges.length ? 'todo' : 'done',
                items: !shared.length ? [{ text: 'None of your computers is set up for sharing (Link’s --desk-host --shared).', state: 'optional' }] : accessChanges.map((a) => ({ text: `${a.name}: ${list(a.words)}`, state: 'todo' })),
                recommended: accessChanges.length ? { label: 'Open them to others', detail: accessChanges.map((a) => `${a.name}: ${list(a.words)}`), apply: { type: 'access', changes: accessChanges } } : null,
            }));

        // ── Coding ──
        const workers = ms.filter((m) => arr(m.roles).includes('codes.worker'));
        const ready = workers.filter((m) => arr(m.fleet).some((a) => a && a.installed && a.signed_in));
        steps.push(step('coding', 'Coding', 'Let your computers do coding tasks',
            'Coding tasks you start on openvibe.codes run on a computer with the Codes runner, using the coding apps signed in there (Claude Code, Codex, OpenCode …) or a model key.',
            {
                state: machines == null ? 'unknown' : ready.length ? 'done' : workers.length ? 'needs_you' : 'todo',
                items: workers.length && !ready.length ? workers.map((m) => ({ text: `${m.name || 'A computer'}: no coding app is signed in yet`, state: 'todo' })) : [],
                why: workers.length && !ready.length ? 'Sign in a coding app on that computer (for example: codex login), or add a model key for its runner.' : null,
                open: { label: 'Open Codes', href: 'https://openvibe.codes' },
            }));

        // ── Agents ──
        steps.push(step('agents', 'Agents', 'Your agents',
            'Your agents live on OpenVibe.Actor (openvibe.actor). Vibe is your first one. Make more, give each a name and a face, share them, and install other people’s: each says in plain words what it may do before you install it.',
            { state: 'optional', open: { label: 'Open OpenVibe.Actor', href: 'https://openvibe.actor' } }));

        // ── Everything else only the owner can give, a step per group ──
        for (const g of arr(setup && setup.groups)) {
            if (SKIP_GROUPS.has(g.id)) continue;
            const rows = arr(g.rows);
            const needed = rows.filter((r) => r.state === 'needed' || r.state === 'not_working');
            const optional = rows.filter((r) => r.state === 'optional');
            steps.push(step(`keys-${g.id}`, 'Keys and accounts', g.label,
                needed.length ? `${needed.length} thing${needed.length === 1 ? '' : 's'} here wait${needed.length === 1 ? 's' : ''} on you. Paste each one below; “Where to get it” opens the page where it is made.` : optional.length ? 'Nothing waits on these; add them when you want what they unlock.' : 'All connected.',
                {
                    state: needed.length ? 'needs_you' : optional.length ? 'optional' : 'done',
                    // The rows themselves (11-14, the owner: "bring you to a place to actually configure it while also having a
                    // link to where to actually obtain it"): the guide draws them with the Setup tab's field, Save, Test and
                    // "Where to get it". Waiting first, then the optional ones, then what is set.
                    rows: [...needed, ...optional, ...rows.filter((r) => r.state === 'connected')].map((r) => r.id),
                    count: needed.length,
                    open: { label: 'Open in Setup', href: `/admin/setup#${g.id}` },
                }));
        }

        const counted = steps.filter((s) => s.id !== 'welcome');
        for (const s of steps) if (skipped.has(s.id) && s.state !== 'done') s.state = 'skipped';
        const done = counted.filter((s) => s.state === 'done').length;
        const open = counted.filter((s) => s.state === 'todo' || s.state === 'needs_you');
        steps.push(step('finish', 'Finish', open.length ? 'What is left' : 'All set',
            open.length ? `${done} of ${counted.length} steps are done. These still want you:` : 'Everything the guide covers is set up. Come back any time: it rereads the live state each time.',
            { state: open.length ? 'todo' : 'done', items: open.map((s) => ({ text: s.count ? `${s.title} · ${s.count} waiting` : s.items && s.items.length ? `${s.title} · ${s.items.length} to do` : s.title, step: s.id, state: s.state })) }));
        const next = steps.find((s) => s.id !== 'welcome' && (s.state === 'todo' || s.state === 'needs_you')) || null;
        return { steps, done, total: counted.length, next: next ? next.id : 'finish' };
    }

    const api = { build, recommendMachine, machineChange, capFor, keysWanted, ROLE_WORDS, SWITCH_WORDS, ACCESS_WORDS };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.OVGuideRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
