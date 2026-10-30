-- phase: expand
-- The site switcher (openvibe-shared switcher.js, 2026-10-30; the owner: "clicking the icon … its own drop-down … all
-- the sites, so you can hop between them fast"): the sites a person pinned and the ones they visited last follow the
-- account to every OpenVibe site, the way display_prefs does. One JSON value per person, { pinned: [id], recent: [id] },
-- in the row they already have; an older release never reads it.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS site_prefs text COLLATE "C";
