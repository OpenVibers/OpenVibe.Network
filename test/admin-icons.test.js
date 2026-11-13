'use strict';
// Plan §Z.1.4 (the owner, 11-13: "add icons throughout the whole admin panel and everywhere"): every action in
// /admin wears an icon. This reads the panel's own sources — public/js/admin/*.js and public/admin.html — and
// fails when a button that says something carries no glyph, or when it wears a glyph the plan's table does not
// name. Static: no browser, no server.
//
//   node test/admin-icons.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const adminDir = path.join(pub, 'js', 'admin');

// The plan's table: the only icons a button may wear. The verb is the button's first word or its meaning.
const TABLE = new Set([
    'floppy-disk', 'xmark', 'plus', 'pen', 'trash', 'rotate-right', 'rotate', 'arrows-rotate', 'pause', 'play',
    'power-off', 'flask', 'forward', 'check', 'wand-magic-sparkles', 'sliders', 'clock-rotate-left', 'key',
    'circle-xmark', 'arrow-up-right-from-square', 'copy', 'magnifying-glass', 'download', 'upload', 'shield-halved',
    'eye', 'eye-slash', 'ellipsis',
]);

// The names each page already wore before the plan (the tabs' own glyphs and the panel's older icons). A name
// that is neither in the table nor here is a typo, so the check below fails on it.
const PREEXISTING = {
    'admin.html': ['arrow-left', 'arrow-up-right-from-square', 'ban', 'bell', 'bolt', 'broadcast-tower', 'bullhorn',
        'chart-area', 'chart-column', 'chart-line', 'chevron-left', 'chevron-right', 'circle-exclamation',
        'clipboard-list', 'clock', 'clock-rotate-left', 'credit-card', 'desktop', 'diagram-project',
        'earth-americas', 'envelope', 'gauge', 'gauge-high', 'gavel', 'gear', 'globe', 'hard-drive', 'key', 'laptop',
        'layer-group', 'link', 'list-check', 'message', 'money-bill-transfer', 'network-wired', 'palette',
        'paper-plane', 'paste', 'ranking-star', 'robot', 'rotate', 'route', 'search', 'server', 'shield-halved',
        'signal', 'snowflake', 'user-check', 'users', 'volume-high'],
    'ai.js': ['arrow-right', 'check-circle', 'circle-check', 'circle-question', 'circle-xmark', 'cloud', 'cookie',
        'cookie-bite', 'flask-vial', 'floppy-disk', 'heart-pulse', 'kit-medical', 'lock', 'magnifying-glass',
        'people-group', 'play', 'plus', 'sliders', 'trash', 'triangle-exclamation', 'volume-high',
        'wand-magic-sparkles', 'wrench', 'xmark-circle'],
    'ai-setup.js': ['arrow-left', 'arrow-right', 'arrow-up-right-from-square', 'check', 'chevron-right', 'coins',
        'flag', 'flag-checkered', 'gift', 'lock', 'minus', 'play', 'sliders', 'star', 'ticket',
        'triangle-exclamation', 'wand-magic-sparkles'],
    'analytics.js': ['arrow-up-from-bracket', 'bars', 'circle-exclamation', 'code', 'eye', 'gauge-high', 'id-card',
        'lightbulb', 'robot', 'user', 'user-plus', 'users', 'wand-magic-sparkles'],
    'boot.js': ['desktop', 'lock'],
    'content.js': ['bell', 'box-archive', 'chart-line', 'circle-check', 'circle-xmark', 'clock', 'clock-rotate-left',
        'cloud', 'code', 'code-fork', 'database', 'envelope', 'flask-vial', 'floppy-disk', 'folder', 'folder-tree',
        'globe', 'hard-drive', 'image', 'key', 'layer-group', 'lock', 'money-bill', 'paper-plane', 'paste', 'rotate',
        'sliders', 'trash-can', 'triangle-exclamation', 'video'],
    'core.js': [],
    'dashboard.js': ['ban', 'bell', 'broadcast-tower', 'ghost', 'plug', 'users', 'video'],
    'domains.js': ['globe'],
    'glossary.js': [],
    'guide-rules.js': [],
    'guide.js': ['arrow-left', 'arrow-right', 'arrow-up-right-from-square', 'check', 'circle', 'circle-check',
        'circle-dot', 'forward', 'hand', 'rotate', 'triangle-exclamation', 'wand-magic-sparkles'],
    'inference.js': ['arrow-down', 'arrow-up', 'chevron-down', 'comments', 'hourglass-half', 'image', 'lock',
        'magnifying-glass', 'microphone-lines', 'user-lock', 'xmark'],
    'moderation.js': ['chevron-left', 'chevron-right', 'user-check', 'user-minus'],
    'payments.js': ['arrow-up-right-from-square', 'floppy-disk', 'link'],
    'settings.js': ['arrows-rotate', 'bell', 'broadcast-tower', 'comments', 'credit-card', 'ellipsis', 'floppy-disk',
        'photo-film', 'plug', 'robot', 'rotate', 'rotate-left', 'save', 'sliders', 'volume-high'],
    'setup.js': ['arrow-up-right-from-square', 'list-check', 'lock'],
    'tools-workers.js': [],
    'users.js': ['ban', 'chevron-left', 'chevron-right', 'envelope', 'key', 'right-from-bracket', 'signature',
        'user-check'],
};

// Buttons that say a name, not an action: they wear no icon on purpose. Each one needs a reason.
const SKIP = [
    { file: 'admin.html', re: /onclick="showSettingsSub\([^"]*\)">[^<]*<\/button>/, why: 'the button names a settings section, not an action' },
    { file: 'admin.html', re: /onclick="showAnalyticsSubTab\([^"]*\)">[^<]*<\/button>/, why: 'the button names an analytics section, not an action' },
    { file: 'ai.js', re: /onclick="aiExplorerLoad\(\$\{u\.id\}\)">@\$\{esc\(u\.username\)\}/, why: 'the chip is a person (a username), not an action' },
    { file: 'moderation.js', re: /onclick="loadLineage\('\$\{esc\(r\)\}'\)">\$\{esc\(label\)\}<\/button>/, why: 'the chip names a moderation reason, not an action' },
];

// The buttons the panel builds with DOM calls: each one puts its <i> first, in its own words.
const DOM_BUILDERS = [
    { file: 'setup.js', re: /b\.innerHTML = \(icon \? '<i class="fa-solid ' \+ icon \+ '"><\/i> ' : ''\) \+ text;/, why: 'setupButton puts its icon first' },
    { file: 'glossary.js', re: /close\.innerHTML = '<i class="fa-solid fa-xmark"><\/i> Close';/, why: 'the glossary close button wears an icon' },
    { file: 'moderation.js', re: /ok\.innerHTML = '<i class="fa-solid fa-check"><\/i> Approve';/, why: 'the theme approve button wears an icon' },
    { file: 'moderation.js', re: /no\.innerHTML = '<i class="fa-solid fa-circle-xmark"><\/i> Reject';/, why: 'the theme reject button wears an icon' },
    { file: 'moderation.js', re: /el\.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square"><\/i> Open ' \+ esc\(w\.tab\);/, why: 'the checklist open button wears an icon' },
];

// The Font Awesome modifiers: they say how to draw the glyph, not which glyph.
const MODIFIERS = new Set(['solid', 'regular', 'light', 'thin', 'duotone', 'sharp', 'classic', 'brands', 'fw', 'lg',
    'xl', 'xs', 'sm', '2xs', '2xl', 'spin', 'spin-pulse', 'spin-reverse', 'pulse', 'beat', 'beat-fade', 'bounce',
    'fade', 'flip', 'shake', 'border', 'inverse', 'li', 'ul', 'stack', 'layers', 'pull-left', 'pull-right']);

const ICON_RE = /<i\b[^>]*\bclass="[^"]*\bfa-solid\b[^"]*"[^>]*>/;

const files = fs.readdirSync(adminDir).filter((f) => f.endsWith('.js')).sort();
const sources = new Map();
for (const f of files) sources.set(f, fs.readFileSync(path.join(adminDir, f), 'utf8'));
sources.set('admin.html', fs.readFileSync(path.join(pub, 'admin.html'), 'utf8'));

function buttonsOf(src) {
    return [...src.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
}

/** The words a button says: its tags (and their attributes) are dropped, its template stays. */
function wordsOf(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** The glyph names a class attribute asks for: the literal ones and the ones a template expression picks. */
function faNames(classAttr) {
    const names = [];
    const rest = classAttr.replace(/^\s*fa-solid\s*/, '').trim();
    const literal = /^\s*fa-([a-z0-9][a-z0-9-]*)/.exec(rest);
    if (literal && !MODIFIERS.has(literal[1])) names.push(literal[1]);
    // The name a template (fa-\${...}) or a concatenation (fa-' + (...) + ') picks.
    for (const m of rest.matchAll(/'\s*([a-z0-9][a-z0-9-]*)/g)) {
        const name = m[1].replace(/^fa-/, '');
        if (name && !MODIFIERS.has(name)) names.push(name);
    }
    return names;
}

// The panel's own sources still parse: a glyph written into a plain string (not a template) breaks the file.
const vm = require('vm');
for (const [file, src] of sources) {
    if (!file.endsWith('.js')) continue;
    assert.doesNotThrow(() => new vm.Script(src, { filename: file }), file + ': the panel source does not parse');
}

let worn = 0;
const tableWorn = new Map();

for (const [file, src] of sources) {
    const allowed = new Set([...TABLE, ...(PREEXISTING[file] || [])]);
    const used = new Set();
    for (const html of buttonsOf(src)) {
        const words = wordsOf(html);
        const hasIcon = ICON_RE.test(html);
        if (!/[A-Za-z]/.test(words)) continue;              // an icon-only or symbol-only button
        if (!hasIcon) {
            const skip = SKIP.find((s) => s.file === file && s.re.test(html));
            assert.ok(skip, file + ': the button "' + words.slice(0, 60) + '" says something but wears no icon');
            continue;
        }
        worn++;
        for (const m of html.matchAll(/<i\b[^>]*class="([^"]*)"[^>]*>/g)) {
            if (!/\bfa-solid\b/.test(m[1])) continue;
            for (const name of faNames(m[1])) {
                assert.ok(allowed.has(name), file + ': fa-' + name + ' is not an icon this page may wear');
                used.add(name);
                if (TABLE.has(name)) tableWorn.set(file, (tableWorn.get(file) || 0) + 1);
            }
        }
    }
}

// Every name button on the skip list is really there, and every reason says why.
for (const s of SKIP) {
    const src = sources.get(s.file);
    assert.ok(src, 'the skip list names a file the panel does not have: ' + s.file);
    assert.ok(s.why.length >= 10, s.file + ': the skip list reason must say why, in ten characters or more');
    assert.ok(buttonsOf(src).some((b) => s.re.test(b)), s.file + ': the skip list entry matches no button any more');
}

// The buttons the panel builds with DOM calls wear their icon, and their words do not come from textContent.
for (const b of DOM_BUILDERS) {
    assert.ok(b.re.test(sources.get(b.file)), b.file + ': ' + b.why);
}
for (const [file, src] of sources) {
    for (const m of src.matchAll(/(\w+)\.textContent = '([^']*)'/g)) {
        if (!/[A-Za-z]/.test(m[2])) continue;
        const isButton = new RegExp('const\\s+' + m[1] + "\\s*=\\s*document\\.createElement\\('button'\\)").test(src);
        assert.ok(!isButton, file + ': the button ' + m[1] + ' takes its words from textContent, so it wears no icon');
    }
}

// Every label the panel's own button builder is given has an icon.
const setupSrc = sources.get('setup.js');
const setupIcons = /const SETUP_BUTTON_ICONS = \{([\s\S]*?)\};/.exec(setupSrc);
assert.ok(setupIcons, 'setup.js names the icon of each of its buttons');
for (const m of setupSrc.matchAll(/setupButton\('([^']+)'/g)) {
    assert.ok(setupIcons[1].includes("'" + m[1] + "':"), 'setup.js: the button "' + m[1] + '" has no icon');
}

// The plan's own files: each one wears the table's icons, so the check cannot pass by doing nothing.
for (const f of ['ai.js', 'ai-setup.js', 'inference.js', 'tools-workers.js', 'moderation.js', 'domains.js']) {
    assert.ok((tableWorn.get(f) || 0) >= 1, f + ': no button wears an icon from the plan\'s table');
}
assert.ok(worn >= 100, 'the panel has buttons that wear an icon (' + worn + ')');

console.log('admin-icons: all checks passed (' + worn + ' buttons wear an icon)');
