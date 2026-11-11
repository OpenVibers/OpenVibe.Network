-- phase: expand
-- The composer's settings (composer.prefs@1): one document per person, the same on every OpenVibe site. The revision
-- is how two tabs agree not to overwrite each other: a PUT names the revision it read, and a moved revision is a 409
-- with the current copy. Additive: a release from before this one never reads the columns.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS composer_prefs text COLLATE "C";
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS composer_rev bigint NOT NULL DEFAULT 0;
