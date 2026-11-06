-- phase: expand
-- OpenVibe Connect, phase 1 (Compute plan E7): the vault of a person's own credentials for the apps their
-- agents act in, the callers those agents come from, the grants they hold, the approvals a send/delete/pay
-- action waits for, the log of what was done and the counters the limits use.
--
-- Additive only: an older release never reads these tables, so this ships on its own and needs no
-- backfill. A credential is stored only sealed (AES-256-GCM under a key derived from NETWORK_SECRETS_KEY,
-- the person's subject and the app as the authenticated data); the plaintext is never written anywhere
-- else, and a row whose ciphertext was shredded keeps its metadata for the log.
CREATE TABLE IF NOT EXISTS connect_credentials (
    id text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    app text COLLATE "C" NOT NULL,
    label text COLLATE "C" NOT NULL,
    scopes text COLLATE "C" NOT NULL DEFAULT '[]',
    key_id text COLLATE "C" NOT NULL,
    iv text COLLATE "C" NOT NULL,
    tag text COLLATE "C" NOT NULL,
    ciphertext text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL,
    last_used_at text COLLATE "C",
    revoked_at text COLLATE "C",
    UNIQUE (subject, app, label)
);

-- A caller: the person themselves, a key the person made on the Apps page (their own Claude Code), or a
-- service acting for them (Codes, Actor). Only the hash of a key is kept.
CREATE TABLE IF NOT EXISTS connect_callers (
    id text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('person', 'key', 'service')),
    name text COLLATE "C" NOT NULL,
    token_hash text COLLATE "C",
    token_prefix text COLLATE "C",
    created_at text COLLATE "C" NOT NULL,
    last_used_at text COLLATE "C",
    revoked_at text COLLATE "C"
);

-- What one caller may do in one app: none (no row), read, or read and write.
CREATE TABLE IF NOT EXISTS connect_grants (
    caller_id text COLLATE "C" NOT NULL REFERENCES connect_callers(id) ON DELETE CASCADE,
    app text COLLATE "C" NOT NULL,
    level text COLLATE "C" NOT NULL CHECK (level IN ('read', 'write')),
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (caller_id, app)
);

-- A send, delete or pay action waits here for the person. The rule is one recipe: the app and the action.
CREATE TABLE IF NOT EXISTS connect_approvals (
    id text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    caller_id text COLLATE "C" NOT NULL,
    app text COLLATE "C" NOT NULL,
    action text COLLATE "C" NOT NULL,
    summary text COLLATE "C" NOT NULL,
    input_digest text COLLATE "C" NOT NULL,
    state text COLLATE "C" NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired')),
    created_at text COLLATE "C" NOT NULL,
    expires_at text COLLATE "C" NOT NULL,
    decided_at text COLLATE "C"
);

-- The log: who, which action, when, and whether it worked. The input of a write action is never written.
CREATE TABLE IF NOT EXISTS connect_log (
    id text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    caller_id text COLLATE "C" NOT NULL,
    caller_name text COLLATE "C" NOT NULL,
    app text COLLATE "C" NOT NULL,
    action text COLLATE "C" NOT NULL,
    risk text COLLATE "C" NOT NULL,
    ok integer NOT NULL,
    status integer,
    error_code text COLLATE "C",
    input text COLLATE "C",
    created_at text COLLATE "C" NOT NULL
);
CREATE INDEX IF NOT EXISTS connect_log_subject_created ON connect_log (subject, created_at DESC);

-- A standing rule: the person says that one recipe (an app and an action) does not have to ask again.
CREATE TABLE IF NOT EXISTS connect_rules (
    subject text COLLATE "C" NOT NULL,
    app text COLLATE "C" NOT NULL,
    action text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (subject, app, action)
);

-- The counters the daily cap counts: one row per person, app and UTC day.
CREATE TABLE IF NOT EXISTS connect_usage_daily (
    subject text COLLATE "C" NOT NULL,
    app text COLLATE "C" NOT NULL,
    day text COLLATE "C" NOT NULL,
    calls bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (subject, app, day)
);
