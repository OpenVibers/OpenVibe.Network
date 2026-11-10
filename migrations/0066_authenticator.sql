-- phase: expand
CREATE TABLE IF NOT EXISTS user_mfa (
    user_id bigint PRIMARY KEY REFERENCES users(id),
    secret_ciphertext text,
    pending_secret_ciphertext text,
    pending_until bigint NOT NULL DEFAULT 0,
    last_step bigint NOT NULL DEFAULT -1,
    failures integer NOT NULL DEFAULT 0,
    locked_until bigint NOT NULL DEFAULT 0,
    enabled_at bigint,
    generation text NOT NULL
);
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
    user_id bigint NOT NULL REFERENCES users(id),
    code_hash text NOT NULL,
    used_at bigint,
    PRIMARY KEY(user_id, code_hash)
);
CREATE TABLE IF NOT EXISTS mfa_challenges (
    token_hash text PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id),
    credential_hash text NOT NULL,
    generation text NOT NULL,
    expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS mfa_challenges_user ON mfa_challenges(user_id);
CREATE TABLE IF NOT EXISTS mfa_devices (
    id text PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id),
    token_hash text NOT NULL,
    generation text NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS mfa_devices_user ON mfa_devices(user_id);
INSERT INTO site_settings (key, value, type) VALUES ('mfa_enrollment', 'off', 'string') ON CONFLICT (key) DO NOTHING;
