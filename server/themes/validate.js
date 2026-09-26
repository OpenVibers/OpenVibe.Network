'use strict';
/**
 * What a community theme (or a person's custom overrides) may contain (roadmap WS-E task 2). A theme is
 * applied by setting CSS custom properties on every OpenVibe site, so both halves are allow-listed:
 *
 *   names   the token vocabulary openvibe-shared ships (its default variables and every built-in
 *           theme's), nothing else: a theme cannot set arbitrary properties
 *   values  colours, numbers, lengths and shadows only: hex, rgb()/rgba()/hsl()/hsla(), plain numbers
 *           (e.g. --accent-rgb "91, 124, 250"), px/rem/em/%, and the keywords below. No url(), var(),
 *           expression(), attr(), quotes, semicolons or braces, so a value cannot fetch anything or
 *           break out of its declaration.
 *
 * cleanVariables(vars) → { ok, variables, errors }: variables are the accepted pairs (trimmed).
 */
const shared = require('openvibe-shared/builtin-themes');

const TOKENS = new Set([
    ...Object.keys(shared.DEFAULT_VARS || {}),
    ...(shared.BUILTIN_THEMES || []).flatMap((t) => Object.keys((t && t.variables) || {})),
]);
const MAX_KEYS = 60;
const MAX_VALUE = 120;
const CHARS = /^[#a-z0-9%.,()\s/+-]+$/i;
const WORDS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'px', 'rem', 'em', 'vh', 'vw', 'deg', 'inset', 'transparent', 'none', 'dark', 'light', 'currentcolor']);

function valueOk(v) {
    if (typeof v !== 'string' && typeof v !== 'number') return false;
    const s = String(v).trim();
    if (!s || s.length > MAX_VALUE || !CHARS.test(s)) return false;
    const words = s.replace(/#[0-9a-f]{3,8}\b/gi, ' ').match(/[a-z]+/gi) || [];
    return words.every((w) => WORDS.has(w.toLowerCase()));
}

function cleanVariables(vars) {
    const errors = [];
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return { ok: false, variables: {}, errors: ['variables must be an object of CSS custom properties'] };
    const entries = Object.entries(vars);
    if (entries.length > MAX_KEYS) errors.push(`at most ${MAX_KEYS} variables`);
    const out = {};
    for (const [k, v] of entries.slice(0, MAX_KEYS)) {
        if (!TOKENS.has(k)) { errors.push(`${String(k).slice(0, 60)} is not a theme token`); continue; }
        if (!valueOk(v)) { errors.push(`${k}: only colours, numbers, lengths and shadows are allowed`); continue; }
        out[k] = String(v).trim();
    }
    if (!Object.keys(out).length && !errors.length) errors.push('no theme tokens given');
    return { ok: errors.length === 0, variables: out, errors };
}

module.exports = { cleanVariables, TOKENS, valueOk };
