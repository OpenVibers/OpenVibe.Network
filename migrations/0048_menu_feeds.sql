-- phase: expand
-- The OpenVibe menu's "Choose your feeds" (2026-11-07): the sites' menu cards a person chose to show, in their
-- order, follow the account to every OpenVibe site, the way site_prefs does. One JSON value per person,
-- { on: ['<site>:<cardId>', …], updated_at }, in the row they already have; an older release never reads it.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS menu_feeds text COLLATE "C";
