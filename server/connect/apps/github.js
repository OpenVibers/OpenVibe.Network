'use strict';
/**
 * GitHub (phase 1): a fine-grained personal access token.
 *
 * The token is the person's own; OpenVibe Connect never asks GitHub for an OAuth app. The walkthrough
 * sends them to GitHub's own settings page, where they choose the repositories and the permissions
 * this file asks for, and paste the token here. The token is sealed in the vault and never shown back.
 *
 * The API host is fixed here: api.github.com. A request may only go there, and a redirect off this host
 * is refused (server/connect/egress.js).
 */
module.exports = {
    key: 'github',
    name: 'GitHub',
    vendor: 'GitHub',
    blurb: 'Repositories, issues and pull requests.',
    apiHost: 'api.github.com',
    docsUrl: 'https://docs.github.com/en/rest',
    auth: {
        kind: 'token',
        label: 'Fine-grained personal access token',
        hint: 'A token for your own account. Give it only the repositories and the permissions below.',
        fields: [
            { name: 'default', label: 'Fine-grained token', placeholder: 'github_pat_…', where: 'header', header: 'Authorization', scheme: 'Bearer' },
        ],
        scopes: ['Metadata: read', 'Contents: read', 'Issues: read and write', 'Pull requests: read and write'],
    },
    walkthrough: [
        { title: 'Open the fine-grained token page', text: 'Sign in to GitHub as yourself. GitHub calls these "personal access tokens (fine-grained)".', link: 'https://github.com/settings/personal-access-tokens/new', linkLabel: 'Open GitHub settings' },
        { title: 'Name the token', text: 'Something like "OpenVibe Connect", so you can recognise it later and revoke it here.', linkLabel: 'The next step' },
        { title: 'Choose the repositories', text: 'Pick only the repositories your agent should touch. "All repositories" gives it every one of them.', linkLabel: 'The next step' },
        { title: 'Set the permissions', text: 'Metadata: read. Contents: read. Issues: read and write. Pull requests: read and write. Nothing else.', linkLabel: 'The next step' },
        { title: 'Generate and copy the token', text: 'GitHub shows the token once. Copy it and paste it below — Connect seals it and never shows it again.', linkLabel: 'The next step' },
    ],
    test: { method: 'GET', path: '/user', summary: 'checks that the token works and says whose it is' },
    actions: [
        {
            name: 'github.repo.read', title: 'Read a repository', risk: 'read',
            description: 'One repository: its name, description, default branch and stars.',
            input: {
                type: 'object',
                properties: { owner: { type: 'string', minLength: 1, maxLength: 100 }, repo: { type: 'string', minLength: 1, maxLength: 100 } },
                required: ['owner', 'repo'], additionalProperties: false,
            },
            request: { method: 'GET', path: '/repos/{owner}/{repo}' },
        },
        {
            name: 'github.issue.list', title: 'List issues', risk: 'read',
            description: 'The open issues of a repository.',
            input: {
                type: 'object',
                properties: {
                    owner: { type: 'string', minLength: 1, maxLength: 100 },
                    repo: { type: 'string', minLength: 1, maxLength: 100 },
                    state: { type: 'string', enum: ['open', 'closed', 'all'] },
                },
                required: ['owner', 'repo'], additionalProperties: false,
            },
            request: { method: 'GET', path: '/repos/{owner}/{repo}/issues', query: { state: '{state}' } },
        },
        {
            name: 'github.issue.create', title: 'Create an issue', risk: 'write',
            description: 'Open a new issue in a repository.',
            input: {
                type: 'object',
                properties: {
                    owner: { type: 'string', minLength: 1, maxLength: 100 },
                    repo: { type: 'string', minLength: 1, maxLength: 100 },
                    title: { type: 'string', minLength: 1, maxLength: 256 },
                    body: { type: 'string', maxLength: 20000 },
                },
                required: ['owner', 'repo', 'title'], additionalProperties: false,
            },
            request: { method: 'POST', path: '/repos/{owner}/{repo}/issues', body: { title: '{title}', body: '{body}' } },
        },
        {
            name: 'github.issue.comment', title: 'Comment on an issue', risk: 'send',
            description: 'Post a comment on an issue. This sends something to people, so it always asks first.',
            input: {
                type: 'object',
                properties: {
                    owner: { type: 'string', minLength: 1, maxLength: 100 },
                    repo: { type: 'string', minLength: 1, maxLength: 100 },
                    number: { type: 'integer', minimum: 1 },
                    body: { type: 'string', minLength: 1, maxLength: 20000 },
                },
                required: ['owner', 'repo', 'number', 'body'], additionalProperties: false,
            },
            request: { method: 'POST', path: '/repos/{owner}/{repo}/issues/{number}/comments', body: { body: '{body}' } },
        },
        {
            name: 'github.issue.comment.delete', title: 'Delete a comment', risk: 'delete',
            description: 'Remove a comment from an issue. This cannot be undone, so it always asks first.',
            input: {
                type: 'object',
                properties: {
                    owner: { type: 'string', minLength: 1, maxLength: 100 },
                    repo: { type: 'string', minLength: 1, maxLength: 100 },
                    comment_id: { type: 'integer', minimum: 1 },
                },
                required: ['owner', 'repo', 'comment_id'], additionalProperties: false,
            },
            request: { method: 'DELETE', path: '/repos/{owner}/{repo}/issues/comments/{comment_id}' },
        },
        {
            name: 'github.pull.create', title: 'Open a pull request', risk: 'write',
            description: 'Open a pull request from a branch into another.',
            input: {
                type: 'object',
                properties: {
                    owner: { type: 'string', minLength: 1, maxLength: 100 },
                    repo: { type: 'string', minLength: 1, maxLength: 100 },
                    title: { type: 'string', minLength: 1, maxLength: 256 },
                    head: { type: 'string', minLength: 1, maxLength: 200 },
                    base: { type: 'string', minLength: 1, maxLength: 200 },
                    body: { type: 'string', maxLength: 20000 },
                },
                required: ['owner', 'repo', 'title', 'head', 'base'], additionalProperties: false,
            },
            request: {
                method: 'POST', path: '/repos/{owner}/{repo}/pulls',
                body: { title: '{title}', head: '{head}', base: '{base}', body: '{body}' },
            },
        },
    ],
};
