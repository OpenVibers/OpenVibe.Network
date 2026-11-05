-- phase: expand
-- Developer API keys and per-project budgets (plan G-P3, Network stays the identity authority).
--
-- A developer API key is a project-bound credential a person shows once and then uses as a bearer
-- credential against OpenVibe.AI. Only sha256(secret) is stored; the secret itself is never stored,
-- never logged and never written to the audit. The key is bound to a project AND to one of the
-- project's apps, so the token it exchanges for is an ordinary app token (sub app:app_<ULID>) with
-- the project's tenancy (project_id, ns) and the key's own environment (live -> production,
-- test -> sandbox).
--
-- The per-project monthly budget is an integer number of nano-USD (decision D1: 1e-9 USD, never a
-- float). It is kept as a decimal string so the value is exact whatever it is, and the column is
-- NULL when the project set no budget (no limit). Billing owns the money; this is the project's own
-- ceiling, which OpenVibe.AI reads with its service token.
--
-- Expand only: an older release never reads these tables and never reads the new columns.
CREATE TABLE IF NOT EXISTS dev_api_keys (
    id text COLLATE "C" PRIMARY KEY,
    project_id text COLLATE "C" NOT NULL REFERENCES dev_projects(id),
    app_id text COLLATE "C" NOT NULL REFERENCES dev_apps(id),
    name text COLLATE "C" NOT NULL,
    key_hash text COLLATE "C" NOT NULL UNIQUE,
    hint text COLLATE "C" NOT NULL,
    scopes text COLLATE "C" NOT NULL DEFAULT '[]',
    environment text COLLATE "C" NOT NULL CHECK (environment IN ('live', 'test')),
    status text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at text COLLATE "C" NOT NULL,
    created_by text COLLATE "C" NOT NULL,
    rotated_at text COLLATE "C",
    revoked_at text COLLATE "C",
    revoked_by text COLLATE "C",
    last_used_at text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS idx_dev_api_keys_project ON dev_api_keys(project_id);
CREATE INDEX IF NOT EXISTS idx_dev_api_keys_app ON dev_api_keys(app_id);

-- The project's own monthly ceiling, in nano-USD (D1). NULL = no budget set.
ALTER TABLE dev_projects ADD COLUMN IF NOT EXISTS monthly_budget_nano_usd text COLLATE "C";
ALTER TABLE dev_projects ADD COLUMN IF NOT EXISTS budget_updated_at text COLLATE "C";
ALTER TABLE dev_projects ADD COLUMN IF NOT EXISTS budget_updated_by text COLLATE "C";
