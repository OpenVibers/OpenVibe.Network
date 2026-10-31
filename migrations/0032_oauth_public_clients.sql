-- phase: expand
-- Public OAuth clients (the Dock in the browser extension, 2026-10-30): a first-party client with no
-- secret, PKCE S256 required, exact redirect URIs and a server-side scope ceiling. Existing
-- confidential clients keep their secret and their optional PKCE; every new column is nullable or has
-- a default, so an older release reads the old columns and the new code reads both shapes.
--
-- allowed_scopes is the ceiling a public client may ask for; NULL means "not a scoped client" (every
-- existing row). access_token_ttl_s is the public client's short access-token life; NULL means the
-- server default. The token claims are Network-private; no contract changes.
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS is_public bigint DEFAULT 0;
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS allowed_scopes text COLLATE "C";
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS access_token_ttl_s integer;
ALTER TABLE oauth_clients ALTER COLUMN client_secret DROP NOT NULL;

-- The account page lists a person's live refresh families; the Dock guard checks that a family is still
-- live on every call. Both are lookups by user (and the existing family index covers the family lookup).
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_live ON oauth_tokens(user_id, revoked);
