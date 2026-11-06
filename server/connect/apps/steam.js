'use strict';
/**
 * Steam (phase 1): a Steam Web API key.
 *
 * The key is created under Steam's developer site (My Account → Web API). It travels as a query
 * parameter, which is how Steam's own API takes it. The API host is fixed here:
 * api.steampowered.com.
 */
module.exports = {
    key: 'steam',
    name: 'Steam',
    vendor: 'Steam',
    blurb: 'Player profiles, owned games and news.',
    apiHost: 'api.steampowered.com',
    docsUrl: 'https://steamcommunity.com/dev',
    auth: {
        kind: 'api_key',
        label: 'Steam Web API key',
        hint: 'The Web API key of your Steam account.',
        fields: [
            { name: 'default', label: 'Web API key', placeholder: '32 hex characters', where: 'query', param: 'key' },
        ],
        scopes: ['Public Steam data'],
    },
    walkthrough: [
        { title: 'Open your Steam account page', text: 'Sign in to Steam, then My Account → Web API.', link: 'https://steamcommunity.com/dev/apikey', linkLabel: 'Open the Steam Web API page' },
        { title: 'Register the key', text: 'Steam shows the key right away, as 32 hexadecimal characters.', linkLabel: 'The next step' },
        { title: 'Paste the key below', text: 'Connect seals it and never shows it again.', linkLabel: 'The next step' },
    ],
    test: { method: 'GET', path: '/ISteamUser/GetPlayerSummaries/v0002/', query: { steamids: '76561197960287930' }, summary: 'checks that the key works' },
    actions: [
        {
            name: 'steam.player.summary', title: 'Read a player profile', risk: 'read',
            description: 'The public profile of one Steam player.',
            input: {
                type: 'object',
                properties: { steamid: { type: 'string', pattern: '^\\d{17}$' } },
                required: ['steamid'], additionalProperties: false,
            },
            request: { method: 'GET', path: '/ISteamUser/GetPlayerSummaries/v0002/', query: { steamids: '{steamid}' } },
        },
        {
            name: 'steam.player.games', title: 'List the games of a player', risk: 'read',
            description: 'The games a Steam player owns.',
            input: {
                type: 'object',
                properties: { steamid: { type: 'string', pattern: '^\\d{17}$' } },
                required: ['steamid'], additionalProperties: false,
            },
            request: { method: 'GET', path: '/IPlayerService/GetOwnedGames/v0001/', query: { steamid: '{steamid}', include_appinfo: '1' } },
        },
        {
            name: 'steam.news.list', title: 'News about an app', risk: 'read',
            description: 'The news feed of one Steam application.',
            input: {
                type: 'object',
                properties: {
                    appid: { type: 'integer', minimum: 1 },
                    count: { type: 'integer', minimum: 1, maximum: 100 },
                },
                required: ['appid'], additionalProperties: false,
            },
            request: { method: 'GET', path: '/ISteamNews/GetNewsForApp/v0002/', query: { appid: '{appid}', count: '{count}' } },
        },
    ],
};
