-- phase: expand
-- plan T21 step 3: every account has a public profile at openvibe.network/@<username> (picture, name, bio, member since,
-- what they wear and the items they own in OpenVibe.Inventory). A person may hide theirs: profile_public = 0 leaves only
-- their name and picture, unindexed. Public by default, as the Live channel pages and Inventory's /u/<subject> already are.
-- Additive: a release from before this one never reads the column.
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_public bigint NOT NULL DEFAULT 1;
