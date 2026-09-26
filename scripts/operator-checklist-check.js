#!/usr/bin/env node
'use strict';
// Probes every console URL in the operator checklist (WS-D task 5): any answer but 404 (or no answer)
// passes, since most consoles ask you to sign in. Exit 1 when one is missing.
//   node scripts/operator-checklist-check.js
const { AREAS } = require('../server/admin/operator-checklist');
(async () => {
    const urls = [...new Set(AREAS.flatMap((a) => a.items.flatMap((i) => i.where.filter((w) => w.kind === 'url').map((w) => w.url))))];
    let bad = 0;
    for (const u of urls) {
        let code = 0;
        try { code = (await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(8000) })).status; } catch { code = 0; }
        const ok = code && code !== 404;
        if (!ok) bad++;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${code || '---'} ${u}`);
    }
    process.exit(bad ? 1 : 0);
})();
