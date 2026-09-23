/**
 * The generated openvibe.live config must carry what production's hand-maintained config
 * (OpenVibe.Live deploy/nginx/openvibe.live.conf) depends on, or regenerating it from the admin
 * panel silently drops WHIP ingest, the connection budgets, the static cache and compression.
 *
 *   node test/nginx-generator-live.test.js
 */
'use strict';
const assert = require('assert');
const g = require('../server/deploy/nginx-generator');

const conf = g.generateServiceConfig('live', g.DEFAULT_SERVICE_MAP.live, { sslEnabled: true, certPath: '/c/f.pem', keyPath: '/c/k.pem' });
const must = [
    ['WHIP hostname', /server_name [^;]*whip\.openvibe\.live/],
    ['ingest hostname', /server_name [^;]*ingest\.openvibe\.live/],
    ['socket connection budget', /limit_conn_zone \$binary_remote_addr zone=addr_limit:10m;[\s\S]*limit_conn addr_limit 256;/],
    ['asset connection budget', /limit_conn_zone \$binary_remote_addr zone=asset_limit:10m;[\s\S]*limit_conn asset_limit 100;/],
    ['static cache zone', /proxy_cache_path \/var\/cache\/nginx\/openvibe-live [^;]*keys_zone=live_static:/],
    ['static cache on the asset location', /location ~ \^\/\(\?!api\/\|ws\/\|data\/\|media\/\)[^{]*\{[^}]*proxy_cache live_static;/],
    ['gzip for proxied text', /gzip_proxied any;/],
    ['upload body size', /location ~ \^\/api\/vods\/\(upload\|clips\|stream\/\) \{[^}]*client_max_body_size 500m;/],
    ['websocket upgrade on catch-all', /location \/ \{[^}]*proxy_set_header Upgrade \$http_upgrade;/],
    ['Cloudflare client IP forwarded', /proxy_set_header CF-Connecting-IP \$http_cf_connecting_ip;/],
    ['access log without query strings (tokens)', /log_format live_noquery [^;]*\$uri[^;]*;[\s\S]*access_log [^;]* live_noquery;/],
    ['capture permissions header', /Permissions-Policy "camera=\*, microphone=\*, display-capture=\*"/],
    ['OpenVibe.Chat locations (glob, before /api/)', /include \/opt\/openvibe\.chat\/deploy\/nginx\/\*\.locations\.conf;[\s\S]*location \/api\/ \{/],
];
for (const [name, re] of must) assert.ok(re.test(conf), `generated live config is missing: ${name}`);
// The asset regex must not swallow /api/ or /ws/ (a regex location beats prefix locations).
assert.ok(!/location ~ \^\/\.\*\\\.\(\?:css/.test(conf), 'asset location must exclude /api/ and /ws/');
// The Network's /shared/ location must leave Cache-Control to the app (five minutes, or immutable
// for a ?v= content-hash URL); an expires/add_header there would send a second, conflicting one.
const net = g.generateServiceConfig('network', g.DEFAULT_SERVICE_MAP.network, { sslEnabled: true, certPath: '/c/f.pem', keyPath: '/c/k.pem' });
const sharedLoc = net.match(/location \/shared\/ \{[^}]*\}/);
assert.ok(sharedLoc, 'generated network config is missing location /shared/');
assert.ok(!/expires|Cache-Control/.test(sharedLoc[0]), 'network /shared/ must not set its own cache headers');
console.log(`nginx generator (live): ${must.length} checks passed; network /shared/ leaves caching to the app`);
