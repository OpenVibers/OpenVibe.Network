'use strict';
/**
 * The hosting plan (plan §AD.18; the owner, 2026-11-17: "figure out which is the best scalable solution for openvibe to
 * replace the singular ovh setup … managed storage options for the database … cheapest hosting setup … that will be
 * able to scale … Output a plan for the new hosting setup to the admin panel").
 *
 * Data, not code: what runs today (measured on the host), the recommendation, the phases with what triggers each and
 * what it costs, and the prices compared, every one with the date it was read and where. The admin panel's Hosting tab
 * (public/js/admin/hosting.js) draws it. GET /api/admin/hosting-plan, admin only (server/index.js).
 *
 * Prices are what the sources said on the day; a provider's own configurator is the price that counts before ordering.
 * Ordering a server is the owner's (money).
 */
const express = require('express');

const CHECKED = '2026-11-17';

const NOW = {
    provider: 'OVHcloud Public Cloud (an OpenStack instance)',
    region: 'US West, Hillsboro (Oregon)',
    facts: [
        { label: 'CPU', value: '4 vCPU', note: 'load 6.6 on 4 cores (11-17 15:37 UTC): more work than cores' },
        { label: 'Memory', value: '15 GB', note: '11 GB in use' },
        { label: 'Disk', value: '100 GB', note: '7–10 GB free after the 11-17 cleanup' },
        { label: 'PostgreSQL', value: '27 GB', note: 'growing about 0.9 GB a day (18.0 → 24.2 GB, 11-10 → 11-17)' },
        { label: 'Services', value: 'about 60', note: 'one host: every site, PostgreSQL, Valkey, Media, streaming' },
    ],
    incidents: [
        '11-16 and 11-17: Media stopped four running recordings to keep the disk from filling (VODs 6522, 6550, 6552, 6567).',
        '11-17 10:20–10:35 UTC: Media refused to record two live streams (disk under 5 GB free).',
        'Deploy rounds dip free space by about 5 GB; 2.9 GB free at 11-17 00:18.',
    ],
};

const RECOMMENDATION = {
    title: 'Bare metal in the same region, then split by tier',
    lines: [
        'Move to one OVHcloud US bare-metal server in Hillsboro: the same region and network as today, so no address or latency change for people, unmetered 1 Gbps (live streaming is mostly bandwidth) and a free private network (vRack) for the servers that come after it.',
        'For about the price of a mid-size cloud instance it gives 6–8 dedicated cores instead of 4 shared vCPU, 32–64 GB of memory instead of 15, and 1 TB of NVMe in RAID 1 instead of 100 GB.',
        'Keep PostgreSQL self-hosted on NVMe with pgBackRest to S3 (as today). Managed PostgreSQL costs 2–4× a whole server at our size; it waits until operating it costs more than paying for it.',
        'Keep ovhost (systemd + nginx + releases) and grow it to several hosts. Kubernetes is not worth its cost or upkeep at this size.',
        'Storage stays where it is: Backblaze B2 for the cold copy, Cloudflare R2 for what plays, Cloudflare in front.',
    ],
};

const PHASES = [
    {
        id: 'p1', title: 'One bare-metal server', when: 'Now', cost: 'about $70–100 a month',
        trigger: 'Today: the disk lost recordings and the CPU runs over its cores.',
        steps: [
            'Order an OVH US Eco Rise or Advance-1 in Hillsboro (6–8 cores, 32–64 GB, 2× NVMe RAID 1, 1 Gbps unmetered, vRack).',
            'Install it with ovhost roles (base, data, web) and pgBackRest; restore PostgreSQL from the S3 repository and catch up by streaming replication.',
            'Move the services with ovhost deploys (same release layout), then switch DNS at Cloudflare service by service.',
            'Keep the Public Cloud instance a week as a standby, then end it.',
        ],
        owner: 'Order and pay for the server.',
    },
    {
        id: 'p2', title: 'The database on its own server', when: 'When PostgreSQL passes ~150 GB or the CPU stays over 60%', cost: 'about +$70–100 a month',
        trigger: 'At ~0.9 GB a day the database reaches 150 GB in about four months.',
        steps: [
            'A second bare-metal server on the vRack for PostgreSQL 18 + PgBouncer; the first becomes the app server.',
            'A streaming replica on the app server for reads and failover; pgBackRest keeps the S3 copy.',
        ],
        owner: 'Order the second server.',
    },
    {
        id: 'p3', title: 'A media tier', when: 'Past ~20 live streams at once, or transcoding queued over 5 minutes', cost: 'about +$70 a month per server',
        trigger: 'Recording, transcoding and cutting are the heaviest work and the first to need more machines.',
        steps: [
            'Media ingest, recording and cutting on their own servers, added one at a time as streams grow.',
            'Playback from R2 through Cloudflare (already); the origin stays out of the viewer path.',
        ],
        owner: 'Order media servers as they are needed.',
    },
    {
        id: 'p4', title: 'A second region, or a managed database', when: 'When revenue covers it', cost: 'managed PostgreSQL ≈ $200–350 a month (4 vCPU / 16 GB / 100 GB)',
        trigger: 'Failover across regions, or when running the database takes more time than it saves.',
        steps: [
            'A standby in OVH US East (Vint Hill) on its own vRack, with a replica; DNS failover at Cloudflare.',
            'Or move PostgreSQL to a managed service with PITR and pooling (compared below).',
        ],
        owner: 'Decide when the cost is worth it.',
    },
];

// Compute: monthly, before tax. `src` is where it was read; `read` the source's own date.
const COMPUTE = [
    { provider: 'OVHcloud US Eco (Rise)', plan: 'Rise (e.g. RISE-S-2)', spec: 'dedicated cores, 32–64 GB, NVMe RAID 1', price: 'from about $62–72', traffic: 'unmetered 1 Gbps', regions: 'Hillsboro OR, Vint Hill VA', note: 'Same region as today; vRack', src: 'https://lp.us.ovhcloud.com/eco/all-servers/', read: '2026-11' },
    { provider: 'OVHcloud US Advance', plan: 'Advance-1 / Advance-3', spec: 'newer AMD, more NVMe', price: 'about $93–102 / from $217', traffic: 'unmetered', regions: 'US (2026 line)', note: 'Bare Metal 2026 line on AMD', src: 'https://us.ovhcloud.com/bare-metal/rise/prices/', read: '2026-11' },
    { provider: 'Hetzner dedicated', plan: 'AX42-1', spec: 'AMD Ryzen, 64 GB, 2× NVMe', price: '€97.30 + €49 setup', traffic: 'unlimited at 1 Gbps', regions: 'EU only (Falkenstein, Nuremberg, Helsinki)', note: 'Price raised 15 June 2026 (was €46 at launch); EU-only adds latency for US people', src: 'https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/', read: '2026-06' },
    { provider: 'Hetzner Cloud (US)', plan: 'CCX13 dedicated vCPU', spec: '2 vCPU, 8 GB', price: '$50.99 (was $19.99)', traffic: 'included', regions: 'Ashburn, Hillsboro', note: 'CCX up 2.1–2.6× in the US on 15 June 2026', src: 'https://dev.to/m_maksimovic_/affordable-alternative-to-hetzner-for-us-companies-3ad9', read: '2026-06' },
    { provider: 'Vultr Bare Metal', plan: 'E3-1270 / E-2286G', spec: '4c/32 GB / 6c/32 GB', price: '$120 / $185', traffic: '10 Gbps port', regions: 'many', note: 'Third-party price list', src: 'https://github.com/xcnsr92/vultr-pricing-breakdown', read: '2026-07-17' },
    { provider: 'Budget US dedicated', plan: 'PureVoltage 2× Gold 6138', spec: '40 threads, 128 GB, 2× 2 TB NVMe', price: '$155', traffic: '100 TB at 10 Gbps', regions: 'New York', note: 'Smaller provider, a forum offer: cheapest power, more risk', src: 'https://lowendtalk.com/discussion/comment/4883114/', read: '2026-10-11' },
];

const DATABASE = [
    { option: 'Self-hosted on the bare-metal server (recommended now)', price: 'included in the server', storage: 'local NVMe', pitr: 'pgBackRest to S3 (running today)', pooling: 'PgBouncer (running today)', src: null, read: CHECKED },
    { option: 'Neon (Launch)', price: '$189.76 at 2 CU, $344.52 at 4 CU (always on)', storage: '$0.35 / GB-month', pitr: 'built in, 6 h–30 d by plan', pooling: 'managed PgBouncer', src: 'https://neon.com/guides/best-postgres-hosting-saas-and-ai-agents-2026', read: '2026-11-13' },
    { option: 'Supabase (Pro)', price: '$36.50 + compute', storage: '$0.125 / GB over 8 GB', pitr: 'add-on ~$100 / $200 / $400 for 7 / 14 / 28 days', pooling: 'Supavisor', src: 'https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery', read: '2026-10-22' },
    { option: 'Nebius Managed PostgreSQL', price: '$211.50 at 4 vCPU / 16 GB; $109.30 at 2 vCPU / 8 GB', storage: '$0.071 / GB-month', pitr: 'included', pooling: '—', src: 'https://docs.nebius.com/postgresql/resources/pricing.md', read: '2026-11-11' },
    { option: 'Crunchy Bridge', price: 'from about $10 + storage', storage: '$0.10 / GB-month', pitr: 'included', pooling: 'included', src: 'https://www.bytebase.com/blog/postgres-hosting-options-pricing-comparison/', read: '2026' },
    { option: 'DigitalOcean Managed', price: 'from $15 (1 vCPU / 1 GB), HA costs more', storage: '$0.215 / GB-month', pitr: 'included', pooling: 'included', src: 'https://selfhost.dev/managed-postgresql-comparison-2026/', read: '2026-10-12' },
];

const STORAGE = [
    { option: 'Cloudflare R2 (in use: what plays)', price: '$15 / TB-month', egress: 'free', note: 'S3-compatible; 10 GB free', src: 'https://mecanik.dev/en/posts/cloudflare-r2-pricing-explained-real-costs-vs-s3-and-backblaze/', read: '2026-10-30' },
    { option: 'Backblaze B2 (in use: the cold copy)', price: '$6.95 / TB-month (from $6 on 1 May 2026)', egress: 'free up to 3× what is stored', note: 'free to Cloudflare', src: 'https://leanopstech-web.pages.dev/blog/backblaze-b2-pricing-2026/', read: '2026-10' },
    { option: 'Wasabi', price: '$7.99 / TB-month', egress: 'free within fair use', note: 'poor fit when serving more than storing', src: 'https://dev.to/devopsdaily/free-egress-has-fine-print-s3-vs-r2-b2-wasabi-and-more-ghf', read: '2026-09-29' },
    { option: 'iDrive e2', price: '$6.00 / TB-month', egress: '3× stored', note: '1 TB minimum', src: 'https://leanopstech-web.pages.dev/blog/cheapest-cloud-storage-2026/', read: '2026' },
    { option: 'Bunny Stream', price: '$10.24 / TB + encoding per minute', egress: 'CDN priced', note: 'encoding, storage and CDN in one', src: 'https://youngju.dev/blog/culture/2026-05-14-object-storage-egress-wars-2026-s3-r2-b2-bunny-wasabi-tigris-deep-dive.en', read: '2026-05-14' },
];

const ORCHESTRATION = [
    { option: 'ovhost across several hosts (recommended)', cost: '$0', upkeep: 'what we do today; grows by adding hosts to the inventory', note: 'Same release layout, deploys, backups and alerts' },
    { option: 'Coolify / Dokploy', cost: '$0 self-hosted', upkeep: '~2 h a month', note: 'One node by design; no SSO', src: 'https://www.qovery.com/blog/coolify-alternatives-compared' },
    { option: 'k3s on our servers', cost: '$0', upkeep: 'cluster upgrades, storage, load balancers', note: 'Worth it only past many servers' },
    { option: 'Managed Kubernetes', cost: '≈ $73 a month for the control plane alone', upkeep: 'workloads only', note: 'Before a single pod runs', src: 'https://medium.com/@ArkProtocol1/forget-eks-a-few-hetzner-boxes-replaced-our-800-month-bill-b4c7ddf991cc' },
];

function plan() {
    return { checked: CHECKED, now: NOW, recommendation: RECOMMENDATION, phases: PHASES, compute: COMPUTE, database: DATABASE, storage: STORAGE, orchestration: ORCHESTRATION,
        owner: ['Order the phase-1 server (money): an OVH US Eco Rise or Advance-1 in Hillsboro.'] };
}

function router() {
    const r = express.Router();
    r.get('/', (req, res) => { res.set('Cache-Control', 'private, no-store'); res.json(plan()); });
    return r;
}

module.exports = { plan, router, CHECKED };
