-- phase: expand
-- Account-owned verified addresses. Existing primary email state remains on users for sign-in recovery and notices.
CREATE TABLE account_emails (
    id text COLLATE "C" PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email text COLLATE "C" NOT NULL,
    verified bigint NOT NULL DEFAULT 0,
    verified_at text COLLATE "C",
    is_primary bigint NOT NULL DEFAULT 0,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);
CREATE UNIQUE INDEX account_emails_email_unique ON account_emails (lower(email));
CREATE UNIQUE INDEX account_emails_one_primary ON account_emails (user_id) WHERE is_primary = 1;
CREATE INDEX account_emails_user_created ON account_emails (user_id, created_at);
INSERT INTO account_emails (id, user_id, email, verified, verified_at, is_primary)
SELECT 'legacy-' || id::text, id, email, email_verified, email_verified_at, 1 FROM users WHERE email IS NOT NULL AND email <> ''
ON CONFLICT DO NOTHING;
ALTER TABLE email_verification_tokens ADD COLUMN IF NOT EXISTS account_email_id text COLLATE "C" REFERENCES account_emails(id) ON DELETE CASCADE;
