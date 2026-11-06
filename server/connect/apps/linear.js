'use strict';
/**
 * Linear (phase 1): a personal API key.
 *
 * Linear's personal API keys are made under Settings → Security & access → API. The key goes in the
 * Authorization header as it is (Linear does not use a "Bearer" prefix). The API host is fixed here:
 * api.linear.app.
 */
module.exports = {
    key: 'linear',
    name: 'Linear',
    vendor: 'Linear',
    blurb: 'Issues and projects in your Linear workspace.',
    apiHost: 'api.linear.app',
    docsUrl: 'https://developers.linear.app/docs',
    auth: {
        kind: 'api_key',
        label: 'Personal API key',
        hint: 'A key for your own Linear account. It acts as you, with the teams you can see.',
        fields: [
            { name: 'default', label: 'API key', placeholder: 'lin_api_…', where: 'header', header: 'Authorization', scheme: null },
        ],
        scopes: ['Your Linear workspace, as you'],
    },
    walkthrough: [
        { title: 'Open Linear', text: 'Sign in to Linear as yourself, on the web.', link: 'https://linear.app/settings/api', linkLabel: 'Open Linear settings' },
        { title: 'Go to Security & access', text: 'In the left menu, "Security & access" holds the API keys.', linkLabel: 'The next step' },
        { title: 'Create a personal API key', text: 'Give it a name you will recognise, such as "OpenVibe Connect".', linkLabel: 'The next step' },
        { title: 'Copy the key', text: 'Linear shows the key once. Copy it and paste it below — Connect seals it and never shows it again.', linkLabel: 'The next step' },
    ],
    test: { method: 'POST', path: '/graphql', body: { query: '{ viewer { id name email } }' }, summary: 'checks that the key works and says whose it is' },
    actions: [
        {
            name: 'linear.issue.list', title: 'List issues', risk: 'read',
            description: 'The issues of a Linear team.',
            input: {
                type: 'object',
                properties: {
                    team: { type: 'string', minLength: 1, maxLength: 100 },
                    first: { type: 'integer', minimum: 1, maximum: 100 },
                },
                required: ['team'], additionalProperties: false,
            },
            request: {
                method: 'POST', path: '/graphql',
                body: {
                    query: 'query($team:String!,$first:Int){ issues(filter:{team:{name:{eq:$team}}},first:$first){ nodes{ id identifier title state{ name } url } } }',
                    variables: { team: '{team}', first: '{first}' },
                },
            },
        },
        {
            name: 'linear.issue.create', title: 'Create an issue', risk: 'write',
            description: 'Open a new issue in a Linear team.',
            input: {
                type: 'object',
                properties: {
                    team: { type: 'string', minLength: 1, maxLength: 100 },
                    title: { type: 'string', minLength: 1, maxLength: 256 },
                    description: { type: 'string', maxLength: 20000 },
                },
                required: ['team', 'title'], additionalProperties: false,
            },
            request: {
                method: 'POST', path: '/graphql',
                body: {
                    query: 'mutation($team:String!,$title:String!,$description:String){ issueCreate(input:{teamId:$team,title:$title,description:$description}){ success issue{ id identifier url } } }',
                    variables: { team: '{team}', title: '{title}', description: '{description}' },
                },
            },
        },
        {
            name: 'linear.issue.comment.create', title: 'Comment on an issue', risk: 'send',
            description: 'Write a comment on a Linear issue. It reaches people, so it always asks first.',
            input: {
                type: 'object',
                properties: {
                    issue_id: { type: 'string', minLength: 1, maxLength: 100 },
                    body: { type: 'string', minLength: 1, maxLength: 20000 },
                },
                required: ['issue_id', 'body'], additionalProperties: false,
            },
            request: {
                method: 'POST', path: '/graphql',
                body: {
                    query: 'mutation($issue:String!,$body:String!){ commentCreate(input:{issueId:$issue,body:$body}){ success comment{ id url } } }',
                    variables: { issue: '{issue_id}', body: '{body}' },
                },
            },
        },
        {
            name: 'linear.issue.delete', title: 'Delete an issue', risk: 'delete',
            description: 'Remove a Linear issue. It cannot be undone, so it always asks first.',
            input: {
                type: 'object',
                properties: { issue_id: { type: 'string', minLength: 1, maxLength: 100 } },
                required: ['issue_id'], additionalProperties: false,
            },
            request: {
                method: 'POST', path: '/graphql',
                body: {
                    query: 'mutation($issue:String!){ issueDelete(id:$issue){ success } }',
                    variables: { issue: '{issue_id}' },
                },
            },
        },
    ],
};
