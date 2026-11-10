'use strict';
/** Only proven earn sources; a positive delta also includes refunds, transfers and grants. */
function earned(row) {
    return Number(row.delta) > 0 && row.app_id === 'quest' && /^quest:[a-z0-9][a-z0-9-]*$/.test(row.reason || '')
        && typeof row.idempotency_key === 'string' && !row.idempotency_key.endsWith(':in');
}
async function onCredit(db, row) {
    if (!earned(row)) return;
    await require('./store').append(db, { user_id: row.user_id, service: 'opencoins', reason: 'quest.completed', amount: Number(row.delta), idempotency_key: `coin:${row.idempotency_key}` });
}
module.exports = { earned, onCredit };
