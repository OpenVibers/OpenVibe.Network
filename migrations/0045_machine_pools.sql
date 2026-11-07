-- phase: expand
-- Same-owner pools. Only public certificates are stored; private keys stay on each Node.
CREATE TABLE IF NOT EXISTS machine_pool_candidates (
    machine_id text COLLATE "C" PRIMARY KEY,
    principal_id text COLLATE "C" NOT NULL REFERENCES platform_node_principals(id),
    owner_subject text COLLATE "C" NOT NULL,
    doc text NOT NULL,
    seen_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS machine_pools (
    id text COLLATE "C" PRIMARY KEY,
    owner_subject text COLLATE "C" NOT NULL,
    head text COLLATE "C" NOT NULL,
    created_at text NOT NULL,
    revoked_at text
);
CREATE TABLE IF NOT EXISTS machine_pool_members (
    pool_id text COLLATE "C" NOT NULL REFERENCES machine_pools(id),
    machine_id text COLLATE "C" NOT NULL,
    principal_id text COLLATE "C" NOT NULL REFERENCES platform_node_principals(id),
    doc text NOT NULL,
    certificate text,
    approved_at text,
    ready boolean NOT NULL DEFAULT false,
    seen_at text,
    PRIMARY KEY (pool_id, machine_id)
);
CREATE INDEX IF NOT EXISTS machine_pools_owner ON machine_pools(owner_subject);
CREATE INDEX IF NOT EXISTS machine_pool_members_machine ON machine_pool_members(machine_id);
