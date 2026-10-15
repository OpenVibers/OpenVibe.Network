-- phase: migrate
-- Preferences that name a theme which does not exist: 'campfire' came from the August import of Live's theme system and
-- was never a Network theme, so 59 people's pages asked GET /api/themes/campfire and got a 404 on every page
-- (2026-10-15). They get the closest built-in, 'ember' (warm, dark). GET /api/themes/campfire also redirects there
-- (server/themes/routes.js RETIRED_THEMES) for pages that still have the old name cached. Idempotent.
UPDATE user_preferences SET theme_id = 'ember', updated_at = ov_now()
 WHERE theme_id = 'campfire' AND EXISTS (SELECT 1 FROM themes WHERE slug = 'ember');
