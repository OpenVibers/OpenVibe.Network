-- phase: expand
ALTER TABLE user_mfa ADD COLUMN IF NOT EXISTS passkey_handle text;
CREATE TABLE IF NOT EXISTS user_passkeys (
    id text PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id),
    public_key text NOT NULL,
    counter bigint NOT NULL DEFAULT 0,
    name text NOT NULL,
    device_type text NOT NULL,
    backed_up boolean NOT NULL,
    created_at bigint NOT NULL,
    last_used_at bigint
);
CREATE INDEX IF NOT EXISTS user_passkeys_user ON user_passkeys(user_id);
CREATE TABLE IF NOT EXISTS passkey_challenges (
    token_hash text PRIMARY KEY,
    user_id bigint REFERENCES users(id),
    purpose text NOT NULL,
    challenge text NOT NULL,
    binding text NOT NULL,
    credential_hash text NOT NULL,
    expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS passkey_challenges_user ON passkey_challenges(user_id);
