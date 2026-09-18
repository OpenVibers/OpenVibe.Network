'use strict';
// "Is this custom domain ready?" — resolves the domain and compares it with where this server
// answers. The expected addresses come from PUBLIC_IP / MEDIASOUP_ANNOUNCED_IP, or from whatever
// openvibe.tools resolves to when neither is set.
const dns = require('dns').promises;
const net = require('net');

const TIMEOUT_MS = 5000;
// Cloudflare's published IPv4 ranges: a proxied domain resolves to these, not to the origin.
const CF_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
    '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14',
    '172.64.0.0/13', '131.0.72.0/22'];
const CF_V6 = ['2400:cb00:', '2606:4700:', '2803:f800:', '2405:b500:', '2405:8100:', '2a06:98c', '2c0f:f248:'];

function v4ToInt(ip) { return ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0); }
function isCloudflare(ip) {
    if (net.isIPv4(ip)) {
        const n = v4ToInt(ip);
        return CF_V4.some(cidr => { const [base, bits] = cidr.split('/'); const size = 2 ** (32 - Number(bits)); const b = v4ToInt(base); return n >= b && n < b + size; });
    }
    const low = String(ip).toLowerCase();
    return CF_V6.some(p => low.startsWith(p));
}

function withTimeout(promise) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
}

async function resolveAll(host, resolver = dns) {
    const grab = async (fn) => {
        try { return { records: await withTimeout(fn()), error: null }; }
        catch (err) { return { records: [], error: ['ENODATA', 'ENOTFOUND', 'ENODOMAIN'].includes(err.code) ? null : (err.code || err.message) }; }
    };
    const [a, aaaa, cname] = await Promise.all([grab(() => resolver.resolve4(host)), grab(() => resolver.resolve6(host)), grab(() => resolver.resolveCname(host))]);
    return { a: a.records, aaaa: aaaa.records, cname: cname.records, error: a.error || aaaa.error || null };
}

async function expectedAddresses(env = process.env, resolver = dns) {
    const fromEnv = [env.PUBLIC_IP, env.MEDIASOUP_ANNOUNCED_IP].map(v => String(v || '').trim()).filter(v => net.isIP(v));
    if (fromEnv.length) return { addresses: [...new Set(fromEnv)], source: 'env' };
    const ref = await resolveAll('openvibe.tools', resolver);
    return { addresses: [...ref.a, ...ref.aaaa], source: 'openvibe.tools' };
}

/**
 * @returns {Promise<{ host, status: 'ready'|'proxied'|'mismatch'|'no_records'|'error', points_here, a, aaaa, cname, expected, expected_source, message }>}
 */
async function checkDomain(host, { env = process.env, resolver = dns } = {}) {
    const [found, expected] = await Promise.all([resolveAll(host, resolver), expectedAddresses(env, resolver)]);
    const addrs = [...found.a, ...found.aaaa];
    const base = { host, a: found.a, aaaa: found.aaaa, cname: found.cname, expected: expected.addresses, expected_source: expected.source };
    if (!addrs.length) {
        if (found.error) return { ...base, status: 'error', points_here: false, message: `DNS lookup failed (${found.error})` };
        return { ...base, status: 'no_records', points_here: false, message: 'No A or AAAA record yet. Add one pointing at this server, then check again.' };
    }
    const want = new Set(expected.addresses);
    const hit = addrs.filter(ip => want.has(ip));
    // Every address family the domain publishes has to land here: an A record that is right next
    // to an AAAA that points elsewhere still sends half the visitors to the wrong machine.
    const v4ok = !found.a.length || found.a.some(ip => want.has(ip));
    const v6ok = !found.aaaa.length || found.aaaa.some(ip => want.has(ip)) || !expected.addresses.some(net.isIPv6);
    if (hit.length && v4ok && v6ok) return { ...base, status: 'ready', points_here: true, message: `Points at this server (${hit.join(', ')}).` };
    if (addrs.some(isCloudflare)) {
        return { ...base, status: 'proxied', points_here: null, message: 'Resolves to Cloudflare. The proxy hides the origin, so this check cannot see where it lands — make sure the Cloudflare DNS record targets this server.' };
    }
    return { ...base, status: 'mismatch', points_here: false, message: `Resolves to ${addrs.join(', ')}, not to this server (${expected.addresses.join(', ') || 'address unknown'}).` };
}

module.exports = { checkDomain, expectedAddresses, resolveAll, isCloudflare };
