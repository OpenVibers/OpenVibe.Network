-- phase: expand
-- Full private history controls and richer page metadata. Existing history remains exportable and deletable.
ALTER TABLE user_history ADD COLUMN IF NOT EXISTS image_url text COLLATE "C";
ALTER TABLE users ADD COLUMN IF NOT EXISTS history_agents_allowed bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS history_keep_private bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS history_keep_mature bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_user_history_user_updated_id ON user_history (user_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_user_history_title_fts ON user_history USING gin (to_tsvector('simple', title));
