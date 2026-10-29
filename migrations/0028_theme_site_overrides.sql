-- phase: expand
-- Per-site theme overrides (the design overhaul, pillar A): one theme follows a person to every OpenVibe site, and
-- this table holds their exceptions ("Games in Neon Tokyo", "Live in Daylight"). One row per person and service; the
-- person's global theme stays in user_preferences, so an older release (and every site that asks for no service)
-- keeps reading the same rows it always did.
CREATE TABLE IF NOT EXISTS user_theme_site_overrides (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service text COLLATE "C" NOT NULL CHECK (service ~ '^[a-z][a-z0-9-]{1,31}$'),
    theme_id text COLLATE "C" NOT NULL,
    custom_variables jsonb,
    updated_at text COLLATE "C" DEFAULT ov_now(),
    PRIMARY KEY (user_id, service)
);
CREATE INDEX IF NOT EXISTS user_theme_site_overrides_service_idx ON user_theme_site_overrides (service);
