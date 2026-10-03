-- phase: expand
-- plan T2 WS-Z2. Delegated grants (docs/t2-projects-and-grants.md section 3, slice 3): what an agent may do for its
-- owner, one row per capability, never more than its host may do for the project (the delegation ceiling, checked by
-- server/developer/agents.js). `mode` is what the owner chose; whether a capability is sensitive is read from the
-- installed catalog on every read, so effective_mode is never stored. revoked is final for that row until the owner
-- sets the grant again.

CREATE TABLE IF NOT EXISTS dev_agent_grants (
    agent_id       text COLLATE "C" NOT NULL REFERENCES dev_agents(id),
    capability     text COLLATE "C" NOT NULL,
    audience       text COLLATE "C" NOT NULL CHECK (audience ~ '^openvibe\.[a-z][a-z0-9-]{0,63}$'),
    mode           text COLLATE "C" NOT NULL CHECK (mode IN ('auto', 'confirm')),
    status         text COLLATE "C" NOT NULL CHECK (status IN ('active', 'revoked')),
    granted_at     text COLLATE "C" NOT NULL,
    granted_by     text COLLATE "C" NOT NULL,
    updated_at     text COLLATE "C" NOT NULL,
    expires_at     text COLLATE "C",
    revoked_at     text COLLATE "C",
    revoked_by     text COLLATE "C",
    revoke_reason  text COLLATE "C",
    PRIMARY KEY (agent_id, capability),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS dev_agent_grants_active_idx ON dev_agent_grants (agent_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS dev_agent_grants_cap_idx    ON dev_agent_grants (capability, status);
