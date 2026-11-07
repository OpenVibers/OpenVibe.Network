/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): starts the page (loaded last).
   Split out of my.html. Classic scripts, global scope: they rely on
   my/core.js's helpers (apiFetch, getAuthToken, showSection, API) and on
   my/boot.js (loaded last), which starts the page. No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// Init. Signed out, loadUser() shows openvibe.my's own sign-in card (or sends a visitor to /login on Network's old
// host): the section and the badge stay unasked, so the page never calls an API that answers 401 on the way there
// (/history, /themes and /notifications logged two each).
OpenVibeAccountSwitcher.init({ apiBase: API, onSwitch: (account) => {
    // Signing out of the switcher (account === null) must clear the host-only SDK session too, or the
    // silent sign-in would bring the person straight back.
    if (!account && MY_HOST) { window.location.replace('/auth/logout?next=%2F'); return; }
    window.location.reload();
} });
const _signedIn = !!(getAuthToken() || getAnonToken());
loadUser();
if (_signedIn) {
    loadToday();
    openInitialSection();
    refreshApprovalsBadge();
}
