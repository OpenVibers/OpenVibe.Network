'use strict';
// The public pages the agent layer serves as HTML and as Markdown twins (openvibe-shared/agent-layer):
// the front door, open stats and the OpenVibeBot page. Each is rendered by the same server renderer the
// page itself uses, so the twin cannot drift from the page. Nothing here is personalised.
const home = require('./home/render');
const stats = require('./stats/open');
const bot = require('./bot/page');

function createAgentPages({ openStats, release = null } = {}) {
    const releaseId = release && release.release;

    async function renderPublicPage(path, { query } = {}) {
        if (path === '/') return { html: home.render({ releaseId }).html };
        if (path === '/stats') {
            const days = stats.windowOf(query && query.get('days'));
            let data = null;
            try { data = await openStats.collect(days); } catch { data = null; }
            return { html: stats.render(data, days, { releaseId }) };
        }
        if (path === '/bot') return { html: bot.render({ releaseId }) };
        return null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
