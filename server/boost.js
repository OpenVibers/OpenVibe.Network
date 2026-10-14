'use strict';
// openvibe-shared/boost.js on Network's server-rendered pages (plan T11 step 3): a page carries the release marker and
// the script, and wraps what changes in <main id="main">. The marker is the served release id (release.release, the id
// /release.json and the ov-release meta carry), so a page from another deploy is a normal page load. Pages without
// the marker (/my, /login, /admin/*, /verify-email, /@:username, the legal pages) are always a normal load.
const esc = require('openvibe-shared/seo').esc;

const meta = (releaseId) => `<meta name="ov-boost" content="network@${esc(releaseId || 'dev')}">`;
const SCRIPT = '<script src="/shared/boost.js" data-main="#main" defer></script>';

module.exports = { meta, SCRIPT };
