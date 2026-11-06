'use strict';
/**
 * Redaction: nothing that looks like a secret leaves the gateway.
 *
 * An answer from an app can carry a token (the app echoed the credential back), a personal detail, or
 * somebody else's key. Three passes catch them:
 *
 *   1. A field whose name says it is a secret (token, secret, password, api_key, access_token,
 *      authorization, cookie, private_key, client_secret, refresh_token) is replaced whole.
 *   2. A value that looks like a secret (a GitHub, Slack, Discord, Google, OpenAI, Anthropic, Notion,
 *      Linear, Steam, Trello or AWS key, a JWT, a private key block) is replaced, wherever it stands.
 *   3. The credential this call used is replaced wherever it appears, even in the middle of a sentence.
 *
 * The result is a copy: the answer the caller gets is the redacted one, and the original never leaves
 * this function.
 */
const REDACTED = '[redacted]';

const SECRET_PATTERNS = [
    /gh[pousr]_[A-Za-z0-9]{30,}/g,                      // GitHub
    /github_pat_[A-Za-z0-9_]{20,}/g,                    // GitHub (fine-grained)
    /xox[baprs]-[A-Za-z0-9-]{10,}/g,                    // Slack
    /sk-ant-[A-Za-z0-9_-]{20,}/g,                       // Anthropic
    /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,                 // OpenAI
    /AIza[0-9A-Za-z_-]{35}/g,                           // Google
    /lin_api_[A-Za-z0-9]{30,}/g,                        // Linear
    /ntn_[A-Za-z0-9]{30,}/g,                            // Notion
    /secret_[A-Za-z0-9]{30,}/g,                         // Notion (older)
    /AKIA[0-9A-Z]{16}/g,                                // AWS
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,   // a JWT
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SECRET_FIELD = /^(?:.*_)?(?:token|secret|password|passwd|api_?key|apikey|access_?key|access_?token|refresh_?token|client_?secret|private_?key|authorization|auth_?token|cookie|session_?key|credential|bearer)(?:_.*)?$/i;

/** One string: the patterns, and the credential this call used. */
function redactString(text, secrets = []) {
    let out = String(text);
    for (const secret of secrets) {
        if (!secret || secret.length < 8) continue;
        out = out.split(secret).join(REDACTED);
    }
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
}

/** Any value: an object, an array, a string. A copy, never the original. */
function redact(value, secrets = [], depth = 0) {
    if (depth > 20) return REDACTED;
    if (typeof value === 'string') return redactString(value, secrets);
    if (Array.isArray(value)) return value.map((v) => redact(v, secrets, depth + 1));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [name, child] of Object.entries(value)) {
            out[name] = SECRET_FIELD.test(name) ? REDACTED : redact(child, secrets, depth + 1);
        }
        return out;
    }
    return value;
}

module.exports = { redact, redactString, REDACTED, SECRET_PATTERNS };
