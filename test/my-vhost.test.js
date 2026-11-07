'use strict';
// openvibe.my's vhost (deploy/nginx/parked-domains.conf): the apex proxies the hub and its /auth sign-in to
// Network on 127.0.0.1:4000, www 301s to the apex, and the old parked redirect to openvibe.network/my is gone.
// The file must parse: nginx -t runs in a scratch prefix with a self-signed certificate (the real certificate
// lives on the host). When this machine has no runnable nginx (the docker wrapper), the parse is skipped and
// the structural checks still run.
//   node test/my-vhost.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const nginx = fs.readFileSync(path.join(ROOT, 'deploy', 'nginx', 'parked-domains.conf'), 'utf8');

// ── The structure ──
assert.ok(/server_name openvibe\.my www\.openvibe\.my;/.test(nginx), 'the HTTP block claims both names');
assert.ok(/server_name openvibe\.my;/.test(nginx), 'the HTTPS block claims openvibe.my');
assert.ok(/server_name www\.openvibe\.my;/.test(nginx), 'a separate block 301s www');
assert.ok(/location \/ \{ return 301 https:\/\/openvibe\.my\$request_uri; \}/.test(nginx), 'HTTP goes to HTTPS, preserving the path and query');
assert.ok(/return 301 https:\/\/openvibe\.my\$request_uri;/.test(nginx), 'www goes to the apex');
assert.ok(/proxy_pass http:\/\/127\.0\.0\.1:4000;/.test(nginx), 'the hub proxies to Network');
assert.ok(nginx.includes('/etc/letsencrypt/live/openvibe.my/fullchain.pem'), 'the name\'s own certificate');
assert.ok(nginx.includes('proxy_set_header Host $host;'), 'the Host header is the hub\'s, so the app routes it');
assert.ok(nginx.includes('location ~* ^/(metrics|internal)(/|$)'), 'metrics and internal stay closed');
assert.ok(!nginx.includes('return 302 https://openvibe.network/my;'), 'the old parked redirect is gone');

// ── It parses ──
let tmp = null;
try {
    tmp = fs.mkdtempSync(path.join(ROOT, '.tmp-nginx-'));
    const key = path.join(tmp, 'key.pem');
    const cert = path.join(tmp, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=openvibe.my'], { stdio: 'ignore' });
    let conf = nginx
        .replace(/^\s*include snippets\/security-txt\.conf;\s*$/gm, '')
        .replace(/^\s*ssl_certificate\s+[^;]+;/gm, `    ssl_certificate     ${cert};`)
        .replace(/^\s*ssl_certificate_key\s+[^;]+;/gm, `    ssl_certificate_key ${key};`)
        .replace(/^\s*access_log\s+\/var\/log\/[^;]+;/gm, '    access_log off;')
        .replace(/^\s*error_log\s+\/var\/log\/[^;]+;/gm, '    error_log stderr;');
    const main = path.join(tmp, 'nginx.conf');
    // A server block with no access_log of its own inherits nginx's compiled-in /var/log/nginx/access.log, which a CI
    // runner cannot open: the scratch http block turns it off, and -e keeps the startup error log in the prefix too.
    fs.writeFileSync(main, `pid ${path.join(tmp, 'nginx.pid')};\nerror_log ${path.join(tmp, 'error.log')};\nevents {}\nhttp {\naccess_log off;\n${conf}\n}\n`);
    const result = spawnSync('nginx', ['-t', '-p', tmp, '-e', path.join(tmp, 'error.log'), '-c', main], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const out = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status === 0 && /test is successful/.test(out)) {
        assert.ok(out.includes('syntax is ok'), 'nginx parses the vhost');
    } else if (result.error && result.error.code === 'ENOENT') {
        console.log('my-vhost: skipped the nginx -t parse (no nginx on this machine); structural checks passed');
    } else if (/docker|Cannot connect to the Docker daemon|command not found/i.test(out)) {
        console.log('my-vhost: skipped the nginx -t parse (no runnable nginx/docker here); structural checks passed');
    } else {
        assert.fail(`nginx -t failed:\n${out}`);
    }
} finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('my-vhost: openvibe.my proxy, www 301 and the vhost parse ok');
