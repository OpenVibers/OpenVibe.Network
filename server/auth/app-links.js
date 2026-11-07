'use strict';
/**
 * Android App Links for OpenVibe Link (plan 2026-11-07 §13.2, RFC 8252 §7.2).
 *
 * A custom scheme belongs to whoever registers it first: any app may answer openvibe-link://auth, run its own
 * authorization request, keep the redirect and receive a code it redeems with its own PKCE pair. An https link is
 * claimed instead: Android hands https://openvibe.network/link/auth to the one app named in
 * /.well-known/assetlinks.json for the certificate it was signed with, and to the browser only when none matches.
 *
 * So a session token — the person's own role and audiences — is issued only when BOTH hold: the authorization returned
 * to that https link, and at least one release fingerprint is published. Without fingerprints (the owner has not made
 * the release key yet) nothing is verified, the https link opens this page in the browser, and the link client gets the
 * extension's read-only Dock token, as every other public client does.
 */
const PACKAGE = 'network.openvibe.link';
const APP_LINK = 'https://openvibe.network/link/auth';
// A debug build's return: still a valid redirect, but a scheme any app can claim, so a Dock token only.
const CUSTOM_SCHEME = 'openvibe-link://auth';
const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** The sentence the account chooser says before OpenVibe Link signs in: it acts as the person, never as staff. */
const CONSENT_TEXT = "OpenVibe Link on your phone will act as you: answer your agents' approvals and send files to your Download.";

/** The release certificate fingerprints published today; none until LINK_ANDROID_CERT_SHA256 is set. */
function fingerprints() {
    return String(process.env.LINK_ANDROID_CERT_SHA256 || '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => FINGERPRINT_RE.test(s));
}

/** The authorization returned to the claimed https link (an exact match, ignoring case). */
function isAppLink(uri) {
    return typeof uri === 'string' && uri.toLowerCase() === APP_LINK;
}

/** /.well-known/assetlinks.json: the app allowed to claim /link/auth, for the certificates in the env. */
function assetLinks() {
    return [{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: PACKAGE, sha256_cert_fingerprints: fingerprints() },
    }];
}

/**
 * The page /link/auth answers when the browser got the link because no installed app could claim it (the fingerprints
 * are unpublished, the app is missing, or the phone could not verify). It says what to do and never echoes the code:
 * the code is single-use and belongs to the app, not to a page anyone could bookmark.
 */
function page() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Open this in OpenVibe Link</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1120;color:#e6ecff;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:34rem;padding:2rem}
h1{font-size:1.6rem;margin:0 0 1rem}
p{margin:0 0 .8rem;color:#a9b6d6}
</style>
</head>
<body>
<main>
<h1>Open this in OpenVibe Link</h1>
<p>This is where signing in to OpenVibe Link on your phone returns. If you can read this page, the app did not open it.</p>
<p>Make sure OpenVibe Link is installed on this phone, then start the sign-in again from the app.</p>
</main>
</body>
</html>`;
}

/** The two routes, mounted by server/index.js and by its tests. */
function mount(app) {
    app.get('/.well-known/assetlinks.json', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/json').send(JSON.stringify(assetLinks()));
    });
    app.get('/link/auth', (_req, res) => {
        res.set('X-Robots-Tag', 'noindex, nofollow').set('Cache-Control', 'no-store');
        res.type('html').send(page());
    });
    return app;
}

module.exports = { PACKAGE, APP_LINK, CUSTOM_SCHEME, CONSENT_TEXT, fingerprints, isAppLink, assetLinks, page, mount };
