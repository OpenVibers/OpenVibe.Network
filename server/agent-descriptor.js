'use strict';
// What openvibe.network tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field here is something this site really serves; the OpenAPI document is the network service's own,
// published by OpenVibe.Services from openvibe-contracts.
module.exports = {
    id: 'network',
    name: 'OpenVibe.Network',
    purpose: 'The front door of OpenVibe: one free account that signs you in on every OpenVibe site, public profiles, themes, notifications, and the network\'s open stats.',
    home: 'https://openvibe.network',
    site: 'openvibe.network',
    api: '/api/v1',
    openapi: 'https://openvibe.services/docs/api/network.json',
    docs: 'https://openvibe.services/docs/api',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: '600 API requests a minute per address; sign-in attempts are limited to 30 per 15 minutes',
    },
};
