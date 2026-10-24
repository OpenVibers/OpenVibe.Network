/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): starts the page (loaded last).
   Split out of my.html. Classic scripts, global scope: they rely on
   my/core.js's helpers (apiFetch, getAuthToken, showSection, API) and on
   my/boot.js (loaded last), which starts the page. No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// Init. Signed out, loadUser() sends the visitor to /login: the section and the badge stay unasked, so the page never
// calls an API that answers 401 on the way there (/history, /themes and /notifications logged two each).
OpenVibeAccountSwitcher.init({ apiBase: API });
const _signedIn = !!(getAuthToken() || getAnonToken());
loadUser();
buildDashboardShowcase();
if (_signedIn) {
    openInitialSection();
    refreshApprovalsBadge();
}
