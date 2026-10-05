/* ═══════════════════════════════════════════════════════════════
   OpenVibe.Network — account hub (/my): starts the page (loaded last).
   Split out of my.html. Classic scripts, global scope: they rely on
   my/core.js's helpers (apiFetch, getAuthToken, showSection, API) and on
   my/boot.js (loaded last), which starts the page. No ES modules.
   ═══════════════════════════════════════════════════════════════ */
// Init
OpenVibeAccountSwitcher.init({ apiBase: API });
loadUser();
buildDashboardShowcase();
openInitialSection();
refreshApprovalsBadge();
