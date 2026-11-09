-- phase: expand
-- A person's ordered menu Home icons and folders; erasure follows user_preferences.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS home_screen text COLLATE "C";
