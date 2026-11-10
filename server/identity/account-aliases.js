'use strict';

// Existing merged accounts remain able to sign in to their surviving account.
async function effectiveUser(db, user) {
    if (!user || !user.merged_into) return user;
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(user.merged_into) || user;
}

module.exports = { effectiveUser };
