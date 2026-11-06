'use strict';
/**
 * Google (phase 1): an API key, and only the APIs that take one.
 *
 * Most of Google's personal APIs (Gmail, Drive, Calendar) want an OAuth sign-in as you, and that is
 * phase 2. What works with a plain API key today is the Cloud Translation API, so that is what this
 * app does. The API host is fixed here: translation.googleapis.com.
 */
module.exports = {
    key: 'google',
    name: 'Google',
    vendor: 'Google',
    blurb: 'Translation through a Google API key (the personal APIs come with OAuth in phase 2).',
    apiHost: 'translation.googleapis.com',
    docsUrl: 'https://cloud.google.com/translate/docs',
    auth: {
        kind: 'api_key',
        label: 'Google Cloud API key',
        hint: 'An API key of your own Google Cloud project, restricted to the Translation API.',
        fields: [
            { name: 'default', label: 'API key', placeholder: 'AIza…', where: 'query', param: 'key' },
        ],
        scopes: ['Cloud Translation API only'],
    },
    walkthrough: [
        { title: 'Open Google Cloud console', text: 'Sign in with the Google account whose project you want to use.', link: 'https://console.cloud.google.com/apis/credentials', linkLabel: 'Open the credentials page' },
        { title: 'Create an API key', text: 'Credentials → Create credentials → API key.', linkLabel: 'The next step' },
        { title: 'Restrict the key', text: 'Under API restrictions, allow only the Cloud Translation API. An unrestricted key is a key anyone can spend.', linkLabel: 'The next step' },
        { title: 'Paste the key below', text: 'Connect seals it and never shows it again.', linkLabel: 'The next step' },
    ],
    test: { method: 'GET', path: '/language/translate/v2', query: { q: 'hello', target: 'es' }, summary: 'checks that the key works' },
    actions: [
        {
            name: 'google.translation.translate', title: 'Translate text', risk: 'read',
            description: 'Translate a piece of text into another language.',
            input: {
                type: 'object',
                properties: {
                    q: { type: 'string', minLength: 1, maxLength: 5000 },
                    target: { type: 'string', pattern: '^[a-z]{2,10}$' },
                    format: { type: 'string', enum: ['text', 'html'] },
                },
                required: ['q', 'target'], additionalProperties: false,
            },
            request: { method: 'GET', path: '/language/translate/v2', query: { q: '{q}', target: '{target}', format: '{format}' } },
        },
        {
            name: 'google.translation.detect', title: 'Detect the language', risk: 'read',
            description: 'Say which language a piece of text is in.',
            input: {
                type: 'object',
                properties: { q: { type: 'string', minLength: 1, maxLength: 5000 } },
                required: ['q'], additionalProperties: false,
            },
            request: { method: 'GET', path: '/language/translate/v2', query: { q: '{q}', dt: 't' } },
        },
    ],
};
