const assert = require('assert');
const adminRoutes = require('../server/admin/routes');

const getServiceRefreshInfo = adminRoutes._getServiceRefreshInfo;

assert.ok(typeof getServiceRefreshInfo === 'function', 'Expected getServiceRefreshInfo helper to exist');

const mockReq = {
    app: {
        locals: {
            config: {
                services: {
                    live: { internalUrl: 'http://127.0.0.1:3000' },
                },
            },
        },
    },
};

const networkInfo = getServiceRefreshInfo(mockReq, 'network');
assert.strictEqual(networkInfo.mode, 'local');
assert.strictEqual(networkInfo.service, 'network');
assert.strictEqual(networkInfo.configured, true);
assert.strictEqual(networkInfo.target, null);

const docsInfo = getServiceRefreshInfo(mockReq, 'docs');
assert.strictEqual(docsInfo.mode, 'not_configured');
assert.strictEqual(docsInfo.configured, false);
assert.strictEqual(docsInfo.target, null);

const streamerInfo = getServiceRefreshInfo(mockReq, 'live');
assert.strictEqual(streamerInfo.mode, 'remote');
assert.strictEqual(streamerInfo.configured, true);
assert.strictEqual(streamerInfo.target, 'http://127.0.0.1:3000/internal/url-registry/refresh');

console.log('✅ Admin service refresh helper tests passed');
