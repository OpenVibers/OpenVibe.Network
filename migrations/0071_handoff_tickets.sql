-- phase: expand
-- One-time cross-site sign-in handoff tickets (signin arrival part 3): a signed-in person's
-- source site mints a short-lived opaque ticket for one destination OAuth client, and the
-- destination redeems it server-to-server for a standard authorization code. Only the SHA-256
-- hash is stored; redemption is atomic single-use. Additive: older releases never read this table.
CREATE TABLE IF NOT EXISTS handoff_tickets (
    ticket_hash text COLLATE "C" PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id text COLLATE "C" NOT NULL REFERENCES oauth_clients(client_id),
    redirect_uri text COLLATE "C" NOT NULL,
    scope text COLLATE "C" DEFAULT 'profile theme',
    source text COLLATE "C",
    issued_at text COLLATE "C" NOT NULL,
    expires_at text COLLATE "C" NOT NULL,
    used bigint NOT NULL DEFAULT 0,
    created_at text COLLATE "C" DEFAULT ov_now()
);

CREATE INDEX IF NOT EXISTS handoff_tickets_user_idx ON handoff_tickets (user_id);
