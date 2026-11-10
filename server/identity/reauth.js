'use strict';

const FRESH_SIGN_IN_SECONDS = 10 * 60;
function isFreshSignIn(claims, now = Date.now()) {
    const authTime = Number(claims && claims.auth_time);
    return Number.isFinite(authTime) && now / 1000 - authTime <= FRESH_SIGN_IN_SECONDS;
}
module.exports = { isFreshSignIn };
