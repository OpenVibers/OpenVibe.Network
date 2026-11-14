-- phase: expand
-- Sign-in attempts (plan §AB.20, wave 1): one row per started third-party sign-in, so `state` survives a restart,
-- several Node processes and a load balancer, and is single use. The row holds what the callback needs and nothing a
-- browser could use: the state is a hash, the verifier and nonce are encrypted at rest with Network's own signing key
-- material, and the row is deleted the moment it is redeemed (a replay finds nothing).
CREATE TABLE IF NOT EXISTS signin_states (
    state_hash   text COLLATE "C" PRIMARY KEY,          -- SHA-256 of the state cookie's value; the value itself is never stored
    provider     text COLLATE "C" NOT NULL,             -- the preset id (google, steam, …)
    mode         text COLLATE "C" NOT NULL CHECK(mode IN ('signin', 'link')),
    user_id      bigint,                                -- the person linking, in link mode only
    verifier     text COLLATE "C",                      -- the PKCE verifier, sealed (AES-256-GCM) in the row
    nonce        text COLLATE "C",                      -- the nonce sent to the provider, sealed the same way
    return_to    text COLLATE "C",                      -- 'app' (an OAuth client's sign-in) or the path to come back to
    app_query    text COLLATE "C",                      -- the app's authorize query, replayed after the sign-in
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL                   -- created_at + 10 minutes: one use, then gone
);
CREATE INDEX IF NOT EXISTS signin_states_expires ON signin_states (expires_at);
