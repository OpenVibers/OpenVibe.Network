'use strict';
/**
 * Todoist (phase 1): an API token.
 *
 * The token is made in Todoist's own settings (Settings → Integrations → API token). It travels as a
 * bearer token. The API host is fixed here: api.todoist.com.
 */
module.exports = {
    key: 'todoist',
    name: 'Todoist',
    vendor: 'Todoist',
    blurb: 'Tasks, projects and comments.',
    apiHost: 'api.todoist.com',
    docsUrl: 'https://developer.todoist.com/rest/v2/',
    auth: {
        kind: 'api_key',
        label: 'API token',
        hint: 'The API token of your own Todoist account.',
        fields: [
            { name: 'default', label: 'API token', placeholder: '40 hex characters', where: 'header', header: 'Authorization', scheme: 'Bearer' },
        ],
        scopes: ['Your Todoist account, as you'],
    },
    walkthrough: [
        { title: 'Open Todoist settings', text: 'Sign in to Todoist, then Settings → Integrations.', link: 'https://app.todoist.com/app/settings/integrations', linkLabel: 'Open Todoist settings' },
        { title: 'Copy the API token', text: 'The "API token" line holds 40 hexadecimal characters.', linkLabel: 'The next step' },
        { title: 'Paste the token below', text: 'Connect seals it and never shows it again.', linkLabel: 'The next step' },
    ],
    test: { method: 'GET', path: '/api/v1/tasks', summary: 'checks that the token works' },
    actions: [
        {
            name: 'todoist.task.list', title: 'List tasks', risk: 'read',
            description: 'The tasks of a project, or of every project when none is named.',
            input: {
                type: 'object',
                properties: { project_id: { type: 'string', minLength: 1, maxLength: 100 } },
                required: [], additionalProperties: false,
            },
            request: { method: 'GET', path: '/api/v1/tasks', query: { project_id: '{project_id}' } },
        },
        {
            name: 'todoist.task.create', title: 'Create a task', risk: 'write',
            description: 'Add a task to a project.',
            input: {
                type: 'object',
                properties: {
                    content: { type: 'string', minLength: 1, maxLength: 500 },
                    project_id: { type: 'string', minLength: 1, maxLength: 100 },
                    description: { type: 'string', maxLength: 10000 },
                },
                required: ['content'], additionalProperties: false,
            },
            request: { method: 'POST', path: '/api/v1/tasks', body: { content: '{content}', project_id: '{project_id}', description: '{description}' } },
        },
        {
            name: 'todoist.task.close', title: 'Complete a task', risk: 'write',
            description: 'Close a task.',
            input: {
                type: 'object',
                properties: { task_id: { type: 'string', minLength: 1, maxLength: 100 } },
                required: ['task_id'], additionalProperties: false,
            },
            request: { method: 'POST', path: '/api/v1/tasks/{task_id}/close', body: {} },
        },
        {
            name: 'todoist.comment.create', title: 'Comment on a task', risk: 'send',
            description: 'Write a comment on a task. It reaches people, so it always asks first.',
            input: {
                type: 'object',
                properties: {
                    task_id: { type: 'string', minLength: 1, maxLength: 100 },
                    content: { type: 'string', minLength: 1, maxLength: 10000 },
                },
                required: ['task_id', 'content'], additionalProperties: false,
            },
            request: { method: 'POST', path: '/api/v1/comments', body: { task_id: '{task_id}', content: '{content}' } },
        },
    ],
};
