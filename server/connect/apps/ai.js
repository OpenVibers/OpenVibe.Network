'use strict';
/**
 * OpenAI and Anthropic (phase 1): keys go to OpenVibe.Exchange's "Your keys and accounts" page.
 *
 * These two are one catalogue entry, because they are one thing: a provider key that OpenVibe.AI
 * already holds the way it holds every person's own key, and runs with. Connect does not seal them and
 * does not proxy them; there is no credential here and no action to grant, and the gateway lists no
 * tool for them. What this page offers is the way through to AI, and a note of where the key lives.
 *
 * Phase 2 gives each provider its own OAuth app, and then these become ordinary Connect apps.
 */
module.exports = {
    key: 'ai',
    name: 'OpenAI & Anthropic',
    vendor: 'OpenVibe.AI',
    blurb: 'Provider keys live in OpenVibe.AI under your account; manage them on OpenVibe.Exchange.',
    apiHost: null,
    docsUrl: 'https://openvibe.exchange/api',
    byok: {
        service: 'ai',
        note: 'A provider key is stored by OpenVibe.AI, not by Connect. It is used by AI runs, not by Connect actions.',
        providers: [
            { key: 'openai', name: 'OpenAI', hint: 'An OpenAI API key, for the models AI runs on your own key.', link: 'https://platform.openai.com/api-keys', linkLabel: 'Open the OpenAI keys page' },
            { key: 'anthropic', name: 'Anthropic', hint: 'An Anthropic API key, for the models AI runs on your own key.', link: 'https://console.anthropic.com/settings/keys', linkLabel: 'Open the Anthropic keys page' },
        ],
    },
    auth: {
        kind: 'byok_link',
        label: 'Your own key, on OpenVibe.Exchange',
        hint: 'This key is never stored in Connect. OpenVibe.AI holds it, under your account.',
        fields: [],
        scopes: [],
    },
    walkthrough: [
        { title: 'Open your AI keys', text: 'Your provider keys and supported browser session cookies are managed on OpenVibe.Exchange.', link: 'https://openvibe.exchange/privacy/keys', linkLabel: 'Your keys and accounts' },
        { title: 'Add your key there', text: 'The key is sealed by AI, under your own account, and AI runs on it alone.', linkLabel: 'The next step' },
        { title: 'Come back here', text: 'Connect has nothing to keep for these two: no credential, no grant, no tool.', linkLabel: 'The next step' },
    ],
    test: null,
    actions: [],
};
