-- phase: expand
-- Setup done by your agent (plan §AB.44): a one-time grant lets the owner's own agent save the key(s) of exactly one
-- Setup row, once, within 30 minutes (server/admin/setup-grants.js). Only the SHA-256 of the grant id is kept; a value is
-- never stored here (the owning service seals it). used_at is set by the first save, before anything is written.
CREATE TABLE IF NOT EXISTS setup_grants (
    id_hash        text COLLATE "C" PRIMARY KEY,           -- SHA-256 of the grant id (sgr_…); the id itself is shown once
    owner_user_id  bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_subject  text COLLATE "C" NOT NULL,
    service        text COLLATE "C" NOT NULL,
    namespace      text COLLATE "C" NOT NULL,
    keys           text COLLATE "C" NOT NULL,              -- JSON array of the one to four keys it may save
    provider       text COLLATE "C",
    get_it_at      text COLLATE "C",
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    used_at        timestamptz,
    used_by        text COLLATE "C",                       -- the service that saved (svc:actor)
    run            text COLLATE "C",                       -- the agent run, for the audit line
    saved_keys     text COLLATE "C",
    revoked_at     timestamptz
);
CREATE INDEX IF NOT EXISTS setup_grants_owner ON setup_grants (owner_user_id, expires_at);
