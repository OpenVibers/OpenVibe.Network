'use strict';
/**
 * Trello (phase 1): an API key and a token.
 *
 * Trello splits the credential in two: the key identifies the app, the token identifies the person who
 * granted it. Both are needed for every call, so this app asks for both. The API host is fixed here:
 * api.trello.com.
 */
module.exports = {
    key: 'trello',
    name: 'Trello',
    vendor: 'Trello',
    blurb: 'Boards, lists and cards.',
    apiHost: 'api.trello.com',
    docsUrl: 'https://developer.atlassian.com/cloud/trello/rest/api-group-introduction/',
    auth: {
        kind: 'api_key',
        label: 'API key and token',
        hint: 'Both parts of the credential: the key identifies your Trello app, the token identifies you.',
        fields: [
            { name: 'key', label: 'API key', placeholder: '32 hex characters', where: 'query', param: 'key' },
            { name: 'token', label: 'Token', placeholder: '64 hex characters', where: 'query', param: 'token' },
        ],
        scopes: ['Your Trello boards, as you'],
    },
    walkthrough: [
        { title: 'Open the Trello API key page', text: 'Sign in to Trello, then the power-up admin page.', link: 'https://trello.com/power-ups/admin', linkLabel: 'Open the Trello admin page' },
        { title: 'Copy the key and the token', text: 'The page shows a "Key" and a "Token". The key identifies your app, the token identifies you.', linkLabel: 'The next step' },
        { title: 'Paste both below', text: 'Connect seals each one and never shows either again.', linkLabel: 'The next step' },
    ],
    test: { method: 'GET', path: '/1/members/me', summary: 'checks that the key and token work and whose they are' },
    actions: [
        {
            name: 'trello.board.list', title: 'List boards', risk: 'read',
            description: 'The boards you are a member of.',
            input: {
                type: 'object',
                properties: { filter: { type: 'string', enum: ['open', 'closed', 'all'] } },
                required: [], additionalProperties: false,
            },
            request: { method: 'GET', path: '/1/boards', query: { filter: '{filter}' } },
        },
        {
            name: 'trello.card.list', title: 'List the cards of a board', risk: 'read',
            description: 'The cards of one board.',
            input: {
                type: 'object',
                properties: { board_id: { type: 'string', minLength: 1, maxLength: 100 } },
                required: ['board_id'], additionalProperties: false,
            },
            request: { method: 'GET', path: '/1/boards/{board_id}/cards' },
        },
        {
            name: 'trello.card.create', title: 'Create a card', risk: 'write',
            description: 'Add a card to a list.',
            input: {
                type: 'object',
                properties: {
                    list_id: { type: 'string', minLength: 1, maxLength: 100 },
                    name: { type: 'string', minLength: 1, maxLength: 500 },
                    desc: { type: 'string', maxLength: 10000 },
                },
                required: ['list_id', 'name'], additionalProperties: false,
            },
            request: { method: 'POST', path: '/1/cards', body: { idList: '{list_id}', name: '{name}', desc: '{desc}' } },
        },
        {
            name: 'trello.comment.create', title: 'Comment on a card', risk: 'send',
            description: 'Write a comment on a card. It reaches people, so it always asks first.',
            input: {
                type: 'object',
                properties: {
                    card_id: { type: 'string', minLength: 1, maxLength: 100 },
                    text: { type: 'string', minLength: 1, maxLength: 10000 },
                },
                required: ['card_id', 'text'], additionalProperties: false,
            },
            request: { method: 'POST', path: '/1/cards/{card_id}/actions/comments', body: { text: '{text}' } },
        },
        {
            name: 'trello.card.delete', title: 'Delete a card', risk: 'delete',
            description: 'Remove a card from a board. It cannot be undone, so it always asks first.',
            input: {
                type: 'object',
                properties: { card_id: { type: 'string', minLength: 1, maxLength: 100 } },
                required: ['card_id'], additionalProperties: false,
            },
            request: { method: 'DELETE', path: '/1/cards/{card_id}' },
        },
    ],
};
