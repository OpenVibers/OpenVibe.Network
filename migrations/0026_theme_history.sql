-- phase: expand
-- Theme history (plan 2026-10-28 §5.2, the Design studio's rollback): each theme or custom-colour change a person
-- makes keeps the setting it replaced, newest first; the routes keep the last 50 per person.
CREATE TABLE IF NOT EXISTS user_theme_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    theme_id text COLLATE "C" NOT NULL,
    custom_theme_variables text COLLATE "C",
    source text COLLATE "C",
    created_at text COLLATE "C" DEFAULT ov_now()
);
CREATE INDEX IF NOT EXISTS user_theme_history_user_idx ON user_theme_history (user_id, id DESC);
