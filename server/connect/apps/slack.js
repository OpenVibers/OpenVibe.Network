'use strict';
/**
 * Slack (phase 1): a bot token for the person's own Slack app.
 *
 * The person creates a Slack app of their own, gives it the bot scopes below, installs it in their
 * workspace and pastes the bot token (xoxb-…). The bot posts as the app, not as the person. The API
 * host is fixed here: slack.com.
 */
module.exports = {
    key: 'slack',
    name: 'Slack',
    vendor: 'Slack',
    blurb: 'Channels and messages in the workspace your bot is in.',
    apiHost: 'slack.com',
    docsUrl: 'https://api.slack.com/methods',
    auth: {
        kind: 'bot_token',
        label: 'Bot user OAuth token',
        hint: 'The xoxb-… token of your own Slack app. The bot posts as the app.',
        fields: [
            { name: 'default', label: 'Bot token', placeholder: 'xoxb-…', where: 'header', header: 'Authorization', scheme: 'Bearer' },
        ],
        scopes: ['channels:read', 'groups:read', 'channels:history', 'chat:write'],
    },
    walkthrough: [
        { title: 'Create a Slack app', text: 'Sign in to Slack and create an app from scratch, under your own workspace.', link: 'https://api.slack.com/apps', linkLabel: 'Open the Slack apps page' },
        { title: 'Give it the bot scopes', text: 'OAuth & Permissions → Scopes → Bot Token Scopes: channels:read, groups:read, channels:history, chat:write.', linkLabel: 'The next step' },
        { title: 'Install it in your workspace', text: 'The bot posts as your app, never as you.', linkLabel: 'The next step' },
        { title: 'Copy the bot token', text: 'It starts with xoxb-. Paste it below — Connect seals it and never shows it again.', linkLabel: 'The next step' },
    ],
    test: { method: 'GET', path: '/api/auth.test', summary: 'checks that the token works and which workspace it is in' },
    actions: [
        {
            name: 'slack.channel.list', title: 'List channels', risk: 'read',
            description: 'The conversations the bot is in.',
            input: {
                type: 'object',
                properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
                required: [], additionalProperties: false,
            },
            request: { method: 'GET', path: '/api/conversations.list', query: { limit: '{limit}' } },
        },
        {
            name: 'slack.message.list', title: 'Read a channel', risk: 'read',
            description: 'The recent messages of one channel.',
            input: {
                type: 'object',
                properties: {
                    channel: { type: 'string', minLength: 1, maxLength: 100 },
                    limit: { type: 'integer', minimum: 1, maximum: 200 },
                },
                required: ['channel'], additionalProperties: false,
            },
            request: { method: 'GET', path: '/api/conversations.history', query: { channel: '{channel}', limit: '{limit}' } },
        },
        {
            name: 'slack.message.post', title: 'Post a message', risk: 'send',
            description: 'Send a message to a channel. It reaches people, so it always asks first.',
            input: {
                type: 'object',
                properties: {
                    channel: { type: 'string', minLength: 1, maxLength: 100 },
                    text: { type: 'string', minLength: 1, maxLength: 4000 },
                },
                required: ['channel', 'text'], additionalProperties: false,
            },
            request: { method: 'POST', path: '/api/chat.postMessage', body: { channel: '{channel}', text: '{text}' } },
        },
        {
            name: 'slack.message.delete', title: 'Delete a message', risk: 'delete',
            description: 'Remove a message from a channel. It cannot be undone, so it always asks first.',
            input: {
                type: 'object',
                properties: {
                    channel: { type: 'string', minLength: 1, maxLength: 100 },
                    ts: { type: 'string', minLength: 1, maxLength: 100 },
                },
                required: ['channel', 'ts'], additionalProperties: false,
            },
            request: { method: 'POST', path: '/api/chat.delete', body: { channel: '{channel}', ts: '{ts}' } },
        },
    ],
};
