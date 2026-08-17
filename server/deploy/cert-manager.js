'use strict';

// ═══════════════════════════════════════════════════════════════
// Certificate Manager — Let's Encrypt wildcard cert automation
// Wraps certbot for DNS-01 challenge certificate issuance.
// Supports both Cloudflare automated and manual DNS modes.
// ═══════════════════════════════════════════════════════════════

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CERTBOT_BIN = process.env.CERTBOT_BIN || 'certbot';
const LETSENCRYPT_DIR = process.env.LETSENCRYPT_DIR || '/etc/letsencrypt';
const CLOUDFLARE_INI_PATH = path.join(LETSENCRYPT_DIR, 'cloudflare.ini');

// ── Helpers ──────────────────────────────────────────────────

function execPromise(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: 120_000, ...opts }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
}

function certbotAvailable() {
    try {
        const { execFileSync } = require('child_process');
        execFileSync(CERTBOT_BIN, ['--version'], { timeout: 5000, stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

function cloudflarePluginAvailable() {
    try {
        const { execFileSync } = require('child_process');
        const out = execFileSync(CERTBOT_BIN, ['plugins', '--text'], { timeout: 10_000, stdio: 'pipe' }).toString();
        return out.includes('dns-cloudflare');
    } catch {
        return false;
    }
}

// ── Certificate Status ───────────────────────────────────────

function parseCertbotCertificates(stdout) {
    const certs = [];
    const blocks = stdout.split(/^\s*Certificate Name:/m);
    for (const block of blocks) {
        if (!block.trim()) continue;
        const cert = {};
        const nameMatch = block.match(/^\s*(.+)/);
        if (nameMatch) cert.name = nameMatch[1].trim();
        const idMatch = block.match(/Identifiers:\s*(.+)/);
        if (idMatch) cert.domains = idMatch[1].trim().split(/\s+/);
        const expiryMatch = block.match(/Expiry Date:\s*(\S+\s+\S+)/);
        if (expiryMatch) cert.expiry = expiryMatch[1];
        const validMatch = block.match(/\(VALID:\s*(\d+)\s*days?\)/i);
        if (validMatch) cert.daysRemaining = parseInt(validMatch[1]);
        const invalidMatch = block.match(/\(INVALID/i);
        if (invalidMatch) cert.invalid = true;
        const certPathMatch = block.match(/Certificate Path:\s*(.+)/);
        if (certPathMatch) cert.certPath = certPathMatch[1].trim();
        const keyPathMatch = block.match(/Private Key Path:\s*(.+)/);
        if (keyPathMatch) cert.keyPath = keyPathMatch[1].trim();
        if (cert.name) certs.push(cert);
    }
    return certs;
}

async function getCertificateStatus() {
    if (!certbotAvailable()) {
        return { available: false, error: 'certbot not found', certs: [] };
    }
    try {
        const { stdout } = await execPromise(CERTBOT_BIN, ['certificates', '--non-interactive']);
        const certs = parseCertbotCertificates(stdout);
        return { available: true, certs };
    } catch (err) {
        return { available: true, error: err.message, certs: [] };
    }
}

function getCertPaths(domain) {
    const livePath = path.join(LETSENCRYPT_DIR, 'live', domain);
    const fullchain = path.join(livePath, 'fullchain.pem');
    const privkey = path.join(livePath, 'privkey.pem');
    return {
        livePath,
        fullchain,
        privkey,
        exists: fs.existsSync(fullchain) && fs.existsSync(privkey),
    };
}

function findBestCert(domain) {
    // Check common certbot naming patterns: domain, domain-0001, etc.
    const candidates = [domain];
    for (let i = 1; i <= 10; i++) {
        candidates.push(`${domain}-${String(i).padStart(4, '0')}`);
    }
    let best = null;
    for (const name of candidates) {
        const paths = getCertPaths(name);
        if (paths.exists) {
            best = { certName: name, ...paths };
        }
    }
    return best;
}

// ── Cloudflare Token Management ──────────────────────────────

function writeCloudflareIni(token) {
    const content = `# Cloudflare API token for certbot DNS-01 challenge\ndns_cloudflare_api_token = ${token}\n`;
    fs.mkdirSync(path.dirname(CLOUDFLARE_INI_PATH), { recursive: true });
    fs.writeFileSync(CLOUDFLARE_INI_PATH, content, { mode: 0o600 });
}

function cloudflareIniExists() {
    return fs.existsSync(CLOUDFLARE_INI_PATH);
}

// ── Certificate Issuance ─────────────────────────────────────

/**
 * Issue a wildcard certificate using Cloudflare DNS-01 challenge.
 * Requires certbot + certbot-dns-cloudflare plugin.
 *
 * @param {object} opts
 * @param {string} opts.domain - Base domain (e.g. "openvibe.tools")
 * @param {string} opts.email - ACME registration email
 * @param {string} opts.cloudflareToken - Cloudflare API token
 * @returns {Promise<{ok: boolean, certName: string, output: string}>}
 */
async function issueWildcardCloudflare({ domain, email, cloudflareToken }) {
    if (!certbotAvailable()) throw new Error('certbot is not installed or not in PATH');
    if (!cloudflarePluginAvailable()) throw new Error('certbot-dns-cloudflare plugin is not installed');
    if (!domain || !email || !cloudflareToken) throw new Error('domain, email, and cloudflareToken are required');

    // Write cloudflare credentials
    writeCloudflareIni(cloudflareToken);

    const args = [
        'certonly',
        '--dns-cloudflare',
        '--dns-cloudflare-credentials', CLOUDFLARE_INI_PATH,
        '--dns-cloudflare-propagation-seconds', '30',
        '-d', domain,
        '-d', `*.${domain}`,
        '--email', email,
        '--agree-tos',
        '--non-interactive',
        '--keep-until-expiring',
    ];

    try {
        const { stdout, stderr } = await execPromise(CERTBOT_BIN, args, { timeout: 180_000 });
        const output = (stdout + '\n' + stderr).trim();
        const cert = findBestCert(domain);
        return {
            ok: true,
            certName: cert?.certName || domain,
            certPath: cert?.fullchain || null,
            keyPath: cert?.privkey || null,
            output,
        };
    } catch (err) {
        return {
            ok: false,
            error: err.message,
            output: ((err.stdout || '') + '\n' + (err.stderr || '')).trim(),
        };
    }
}

/**
 * Start a manual DNS-01 challenge for wildcard certificate.
 * Returns the challenge records that need to be created.
 *
 * @param {object} opts
 * @param {string} opts.domain - Base domain
 * @param {string} opts.email - ACME registration email
 * @returns {Promise<{ok: boolean, challenges: Array, processId: string}>}
 */
function startManualDnsChallenge({ domain, email }) {
    if (!certbotAvailable()) throw new Error('certbot is not installed or not in PATH');
    if (!domain || !email) throw new Error('domain and email are required');

    return new Promise((resolve, reject) => {
        const processId = crypto.randomBytes(8).toString('hex');
        const args = [
            'certonly',
            '--manual',
            '--preferred-challenges', 'dns-01',
            '-d', domain,
            '-d', `*.${domain}`,
            '--email', email,
            '--agree-tos',
            '--non-interactive',
            '--manual-auth-hook', '/bin/true',
            '--dry-run',
        ];

        // For manual mode, we use --manual with a dry-run first to get challenge info,
        // then the real issuance requires the user to place DNS records.
        // We use certbot certonly --manual --preferred-challenges dns to get the instructions.

        const challenges = [];
        let output = '';

        const proc = spawn(CERTBOT_BIN, [
            'certonly',
            '--manual',
            '--preferred-challenges', 'dns-01',
            '-d', domain,
            '-d', `*.${domain}`,
            '--email', email,
            '--agree-tos',
            '--keep-until-expiring',
        ], { timeout: 300_000 });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        // Wait for initial output, then parse challenge info
        // certbot manual mode prints challenge instructions to stderr
        const timeout = setTimeout(() => {
            // Parse whatever we have
            const combined = stdout + stderr;
            const challengeMatches = combined.matchAll(/_acme-challenge\.(\S+)\s+.*?with the following value:\s*\n\s*(\S+)/g);
            for (const m of challengeMatches) {
                challenges.push({
                    type: 'DNS TXT',
                    name: `_acme-challenge.${domain}`,
                    value: m[2],
                });
            }

            // Store the process for later continuation
            if (!manualProcesses) {
                // Module-level store initialized below
            }
            manualProcesses.set(processId, { proc, domain, email, challenges, stdout, stderr });

            resolve({
                ok: true,
                processId,
                domain,
                challenges,
                instructions: [
                    `Create DNS TXT record(s) for _acme-challenge.${domain}`,
                    'Wait for DNS propagation (usually 1-5 minutes)',
                    'Then call the confirm endpoint with the processId',
                ],
                output: combined.substring(0, 2000),
            });
        }, 15_000);

        proc.on('close', (code) => {
            clearTimeout(timeout);
            const combined = stdout + stderr;
            if (code === 0) {
                const cert = findBestCert(domain);
                resolve({
                    ok: true,
                    completed: true,
                    certName: cert?.certName || domain,
                    certPath: cert?.fullchain || null,
                    keyPath: cert?.privkey || null,
                    output: combined.substring(0, 2000),
                });
            }
            // Don't reject here - the timeout handler may have already resolved
        });

        proc.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

// Module-level store for in-progress manual challenges
const manualProcesses = new Map();

/**
 * Get the challenge details for a manual DNS issuance that uses certbot's
 * preferred-challenges dns mode. Since certbot's interactive manual mode
 * is complex to automate, we provide a simpler workflow:
 *
 * 1. Generate challenge info by calling ACME directly (or via certbot dry-run)
 * 2. User creates DNS records
 * 3. User confirms → we run the real certbot command
 */
async function getManualChallengeInfo({ domain, email }) {
    if (!certbotAvailable()) throw new Error('certbot is not installed or not in PATH');
    if (!domain || !email) throw new Error('domain and email are required');

    // Use certbot to get the challenge token via a dry run with manual plugin
    // This shows what records would be needed without actually issuing
    try {
        const { stdout, stderr } = await execPromise(CERTBOT_BIN, [
            'certonly',
            '--manual',
            '--preferred-challenges', 'dns-01',
            '-d', domain,
            '-d', `*.${domain}`,
            '--email', email,
            '--agree-tos',
            '--non-interactive',
            '--dry-run',
            '--manual-auth-hook', 'echo',
        ], { timeout: 60_000 });

        const output = (stdout + '\n' + stderr).trim();
        return {
            ok: true,
            domain,
            instructions: [
                `To issue a wildcard certificate for ${domain} and *.${domain}:`,
                '',
                '1. Create a DNS TXT record:',
                `   Name: _acme-challenge.${domain}`,
                '   Value: (provided by Let\'s Encrypt during issuance)',
                '',
                '2. Wait for DNS propagation',
                '',
                '3. Click "Issue Certificate" to run the real challenge',
                '',
                'Note: For wildcard certs, you may need TWO TXT records (one per domain).',
                'Both should use the same _acme-challenge name but different values.',
            ],
            output: output.substring(0, 2000),
        };
    } catch (err) {
        return {
            ok: true,
            domain,
            instructions: [
                `To issue a wildcard certificate for ${domain} and *.${domain}:`,
                '',
                '1. Create DNS TXT record(s):',
                `   Name: _acme-challenge.${domain}`,
                '   Value: (will be provided during issuance)',
                '',
                '2. For manual mode, run on the server:',
                `   sudo certbot certonly --manual --preferred-challenges dns -d ${domain} -d *.${domain} --email ${email}`,
                '',
                '3. Follow the prompts to create DNS records and verify.',
            ],
            error: err.message,
        };
    }
}

/**
 * Issue a wildcard certificate using manual DNS-01 challenge.
 * The caller must have already created the required DNS TXT records.
 * Uses the manual-auth-hook trick: a script that just succeeds,
 * assuming the DNS records are already in place.
 *
 * @param {object} opts
 * @param {string} opts.domain - Base domain
 * @param {string} opts.email - ACME registration email
 * @returns {Promise<{ok: boolean, certName: string, output: string}>}
 */
async function issueWildcardManual({ domain, email }) {
    if (!certbotAvailable()) throw new Error('certbot is not installed or not in PATH');
    if (!domain || !email) throw new Error('domain and email are required');

    // Create a simple auth hook script that exits 0
    // This tells certbot that the DNS records are already in place
    const hookDir = path.join(LETSENCRYPT_DIR, 'hooks');
    const hookPath = path.join(hookDir, 'manual-auth-noop.sh');

    try {
        fs.mkdirSync(hookDir, { recursive: true });
        fs.writeFileSync(hookPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    } catch (err) {
        throw new Error(`Cannot create auth hook: ${err.message}`);
    }

    const args = [
        'certonly',
        '--manual',
        '--preferred-challenges', 'dns-01',
        '-d', domain,
        '-d', `*.${domain}`,
        '--email', email,
        '--agree-tos',
        '--non-interactive',
        '--keep-until-expiring',
        '--manual-auth-hook', hookPath,
    ];

    try {
        const { stdout, stderr } = await execPromise(CERTBOT_BIN, args, { timeout: 180_000 });
        const output = (stdout + '\n' + stderr).trim();
        const cert = findBestCert(domain);
        return {
            ok: true,
            certName: cert?.certName || domain,
            certPath: cert?.fullchain || null,
            keyPath: cert?.privkey || null,
            output,
        };
    } catch (err) {
        return {
            ok: false,
            error: err.message,
            output: ((err.stdout || '') + '\n' + (err.stderr || '')).trim(),
        };
    }
}

/**
 * Renew all certificates.
 * @returns {Promise<{ok: boolean, output: string}>}
 */
async function renewCertificates() {
    if (!certbotAvailable()) throw new Error('certbot is not installed or not in PATH');
    try {
        const { stdout, stderr } = await execPromise(CERTBOT_BIN, ['renew', '--non-interactive'], { timeout: 300_000 });
        return { ok: true, output: (stdout + '\n' + stderr).trim() };
    } catch (err) {
        return {
            ok: false,
            error: err.message,
            output: ((err.stdout || '') + '\n' + (err.stderr || '')).trim(),
        };
    }
}

/**
 * Check system prerequisites for certificate management.
 * @returns {object} Status of certbot, plugins, permissions
 */
function checkPrerequisites() {
    const result = {
        certbotInstalled: certbotAvailable(),
        cloudflarePluginInstalled: false,
        letsencryptDirWritable: false,
        cloudflareIniExists: cloudflareIniExists(),
        nginxInstalled: false,
    };

    if (result.certbotInstalled) {
        result.cloudflarePluginInstalled = cloudflarePluginAvailable();
    }

    try {
        fs.accessSync(LETSENCRYPT_DIR, fs.constants.W_OK);
        result.letsencryptDirWritable = true;
    } catch {
        result.letsencryptDirWritable = false;
    }

    try {
        const { execFileSync } = require('child_process');
        execFileSync('nginx', ['-v'], { timeout: 5000, stdio: 'pipe' });
        result.nginxInstalled = true;
    } catch {
        result.nginxInstalled = false;
    }

    return result;
}

module.exports = {
    getCertificateStatus,
    getCertPaths,
    findBestCert,
    issueWildcardCloudflare,
    getManualChallengeInfo,
    issueWildcardManual,
    renewCertificates,
    checkPrerequisites,
    writeCloudflareIni,
    cloudflareIniExists,
    CERTBOT_BIN,
    LETSENCRYPT_DIR,
};
