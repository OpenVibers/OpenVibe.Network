-- phase: expand
-- The menu Feed's seen time follows a signed-in person across OpenVibe sites.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS feed_seen_at timestamptz;
