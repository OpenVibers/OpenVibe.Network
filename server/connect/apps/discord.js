'use strict';
/**
 * Discord (phase 1): a bot token for the person's own bot.
 *
 * The person creates a bot in the Discord developer portal, invites it to their server and pastes its
 * token. The bot posts as the bot, never as the person. The API host is fixed here: discord.com.
 */
module.exports = {
    key: 'discord',
    name: 'Discord',
    vendor: 'Discord',
    blurb: 'Channels and messages in the servers your bot is in.',
    apiHost: 'discord.com',
    docsUrl: 'https://discord.com/developers/docs/reference',
    auth: {
        kind: 'bot_token',
        label: 'Bot token',
        hint: 'The token of your own Discord bot. It posts as the bot, never as you.',
        fields: [
            { name: 'default', label: 'Bot token', placeholder: 'MTIz…', where: 'header', header: 'Authorization', scheme: 'Bot' },
        ],
        scopes: ['Read messages in the channels the bot can see', 'Send messages', 'Manage its own messages'],
    },
    walkthrough: [
        { title: 'Open the Discord developer portal', text: 'Sign in to Discord, then the Developer Portal → My Applications.', link: 'https://discord.com/developers/applications', linkLabel: 'Open the developer portal' },
        { title: 'Create a new application', text: 'Give it a name and a bot. The bot is a separate user in your server.', linkLabel: 'The next step' },
        { title: 'Copy the bot token', text: 'Bot → Token → Reset/Copy. It is shown once.', linkLabel: 'The next step' },
        { title: 'Invite the bot to your server', text: 'OAuth2 → URL Generator: bot scope, and the permissions it needs (View Channels, Read Message History, Send Messages, Manage Messages).', linkLabel: 'The next step' },
        { title: 'Paste the token below', text: 'Connect seals it and never shows it again.', linkLabel: 'The next step' },
    ],
    test: { method: 'GET', path: '/api/v10/users/@me', summary: 'checks that the token works and which bot it is' },
    actions: [
        {
            name: 'discord.channel.messages', title: 'Read a channel', risk: 'read',
            description: 'The recent messages of one channel.',
            input: {
                type: 'object',
                properties: {
                    channel_id: { type: 'string', minLength: 1, maxLength: 100 },
                    limit: { type: 'integer', minimum: 1, maximum: 100 },
                },
                required: ['channel_id'], additionalProperties: false,
            },
            request: { method: 'GET', path: '/api/v10/channels/{channel_id}/messages', query: { limit: '{limit}' } },
        },
        {
            name: 'discord.message.create', title: 'Post a message', risk: 'send',
            description: 'Send a message to a channel. It reaches people, so it always asks first.',
            input: {
                type: 'object',
                properties: {
                    channel_id: { type: 'string', minLength: 1, maxLength: 100 },
                    content: { type: 'string', minLength: 1, maxLength: 2000 },
                },
                required: ['channel_id', 'content'], additionalProperties: false,
            },
            request: { method: 'POST', path: '/api/v10/channels/{channel_id}/messages', body: { content: '{content}' } },
        },
        {
            name: 'discord.message.delete', title: 'Delete a message', risk: 'delete',
            description: 'Remove a message from a channel. It cannot be undone, so it always asks first.',
            input: {
                type: 'object',
                properties: {
                    channel_id: { type: 'string', minLength: 1, maxLength: 100 },
                    message_id: { type: 'string', minLength: 1, maxLength: 100 },
                },
                required: ['channel_id', 'message_id'], additionalProperties: false,
            },
            request: { method: 'DELETE', path: '/api/v10/channels/{channel_id}/messages/{message_id}' },
        },
    ],
};
