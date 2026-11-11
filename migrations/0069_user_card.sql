-- phase: expand
-- Field visibility for the shared public card. History-derived activity requires an explicit opt-in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS card_visibility jsonb NOT NULL DEFAULT '{}'::jsonb;
INSERT INTO site_settings(key, value, type) VALUES ('user_card_enabled', 'false', 'boolean') ON CONFLICT DO NOTHING;
