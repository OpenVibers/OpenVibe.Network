'use strict';
/**
 * Notion (phase 1): an internal integration token.
 *
 * A Notion integration is created in the Notion app (Settings → Connections → your integration), and
 * its secret is copied once. The token goes in the Authorization header, with Notion's version header.
 * The API host is fixed here: api.notion.com.
 */
module.exports = {
    key: 'notion',
    name: 'Notion',
    vendor: 'Notion',
    blurb: 'Pages and databases in the Notion workspace you share with the integration.',
    apiHost: 'api.notion.com',
    docsUrl: 'https://developers.notion.com/reference/intro',
    headers: { 'Notion-Version': '2022-06-28' },
    auth: {
        kind: 'token',
        label: 'Internal integration token',
        hint: 'The secret of your own integration. Share the pages you want with the integration too.',
        fields: [
            { name: 'default', label: 'Integration token', placeholder: 'ntn_… (or secret_…)', where: 'header', header: 'Authorization', scheme: 'Bearer' },
        ],
        scopes: ['The pages and databases the integration was invited to'],
    },
    walkthrough: [
        { title: 'Open the Notion integrations page', text: 'In the Notion app: Settings, then Connections.', link: 'https://www.notion.so/my-integrations', linkLabel: 'Open Notion integrations' },
        { title: 'Create an internal integration', text: 'Name it "OpenVibe Connect" and pick the workspace.', linkLabel: 'The next step' },
        { title: 'Copy the secret', text: 'Notion shows the internal integration secret once, as "ntn_…" or "secret_…".', linkLabel: 'The next step' },
        { title: 'Share the pages with it', text: 'Open a page, then "…", then Connections, and add your integration. It sees only what you share with it.', linkLabel: 'The next step' },
        { title: 'Paste the secret below', text: 'Connect seals it and never shows it again.', linkLabel: 'The next step' },
    ],
    test: { method: 'GET', path: '/v1/users/me', summary: 'checks that the token works and says whose it is' },
    actions: [
        {
            name: 'notion.search', title: 'Search the workspace', risk: 'read',
            description: 'Find the pages and databases the integration can see.',
            input: {
                type: 'object',
                properties: { query: { type: 'string', maxLength: 200 } },
                required: [], additionalProperties: false,
            },
            request: { method: 'POST', path: '/v1/search', body: { query: '{query}' } },
        },
        {
            name: 'notion.page.read', title: 'Read a page', risk: 'read',
            description: 'One page by its id.',
            input: {
                type: 'object',
                properties: { page_id: { type: 'string', minLength: 1, maxLength: 100 } },
                required: ['page_id'], additionalProperties: false,
            },
            request: { method: 'GET', path: '/v1/pages/{page_id}' },
        },
        {
            name: 'notion.page.create', title: 'Create a page', risk: 'write',
            description: 'Add a page under another page or in a database.',
            input: {
                type: 'object',
                properties: {
                    parent_id: { type: 'string', minLength: 1, maxLength: 100 },
                    title: { type: 'string', minLength: 1, maxLength: 200 },
                    body: { type: 'string', maxLength: 10000 },
                },
                required: ['parent_id', 'title'], additionalProperties: false,
            },
            request: {
                method: 'POST', path: '/v1/pages',
                body: {
                    parent: { page_id: '{parent_id}' },
                    properties: { title: { title: [{ text: { content: '{title}' } }] } },
                    children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '{body}' } }] } }],
                },
            },
        },
        {
            name: 'notion.comment.create', title: 'Comment on a page', risk: 'send',
            description: 'Write a comment on a page. It reaches people, so it always asks first.',
            input: {
                type: 'object',
                properties: {
                    page_id: { type: 'string', minLength: 1, maxLength: 100 },
                    body: { type: 'string', minLength: 1, maxLength: 10000 },
                },
                required: ['page_id', 'body'], additionalProperties: false,
            },
            request: {
                method: 'POST', path: '/v1/comments',
                body: {
                    parent: { page_id: '{page_id}' },
                    rich_text: [{ type: 'text', text: { content: '{body}' } }],
                },
            },
        },
    ],
};
