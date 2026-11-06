'use strict';
/**
 * One re-authentication URL for every fresh-sign-in action (account deletion, account merge, the owner's AI
 * key/money settings, Locker reset/forget, QR transfer rules). The login page's ?reauth=1 always asks for the
 * password, even when a session exists; ?add_account=1 hands that session back with its old auth_time, so the
 * fresh check never passes and the person loops.
 */
function reauthUrl(baseUrl, returnTo = '/') {
    const base = String(baseUrl || 'https://openvibe.network').replace(/\/+$/, '');
    const back = String(returnTo || '/');
    return `${base}/login?reauth=1&return=${encodeURIComponent(back)}`;
}

module.exports = { reauthUrl };
