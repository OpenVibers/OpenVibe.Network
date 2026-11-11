-- phase: expand
-- Machine access and the account's agent directory. All switches default off.
CREATE TABLE IF NOT EXISTS link_access_settings (
    principal_id text COLLATE "C" PRIMARY KEY REFERENCES platform_node_principals(id) ON DELETE CASCADE,
    others_may_ask bigint NOT NULL DEFAULT 0 CHECK (others_may_ask IN (0, 1)),
    auto_agent_send bigint NOT NULL DEFAULT 0 CHECK (auto_agent_send IN (0, 1)),
    agents_talk bigint NOT NULL DEFAULT 0 CHECK (agents_talk IN (0, 1)),
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso()
);

CREATE TABLE IF NOT EXISTS link_access_requests (
    id text COLLATE "C" PRIMARY KEY,
    from_principal text COLLATE "C" NOT NULL REFERENCES platform_node_principals(id),
    to_principal text COLLATE "C" NOT NULL REFERENCES platform_node_principals(id),
    from_owner text COLLATE "C" NOT NULL,
    to_owner text COLLATE "C" NOT NULL,
    from_agent text COLLATE "C",
    scopes text COLLATE "C" NOT NULL,
    reason text COLLATE "C",
    duration_seconds bigint,
    status text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
    asked_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    pending_until text COLLATE "C" NOT NULL,
    answered_at text COLLATE "C",
    CHECK (from_principal <> to_principal)
);
CREATE INDEX IF NOT EXISTS idx_link_access_requests_to ON link_access_requests(to_owner, status, asked_at);
CREATE INDEX IF NOT EXISTS idx_link_access_requests_daily ON link_access_requests(from_owner, to_owner, asked_at);

CREATE TABLE IF NOT EXISTS link_access_grants (
    id text COLLATE "C" PRIMARY KEY,
    request_id text COLLATE "C" REFERENCES link_access_requests(id),
    from_principal text COLLATE "C" NOT NULL REFERENCES platform_node_principals(id),
    to_principal text COLLATE "C" NOT NULL REFERENCES platform_node_principals(id),
    from_owner text COLLATE "C" NOT NULL,
    to_owner text COLLATE "C" NOT NULL,
    scopes text COLLATE "C" NOT NULL,
    approved_by text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    expires_at text COLLATE "C",
    revoked_at text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS idx_link_access_grants_from ON link_access_grants(from_principal, revoked_at);
CREATE INDEX IF NOT EXISTS idx_link_access_grants_to ON link_access_grants(to_principal, revoked_at);

CREATE TABLE IF NOT EXISTS link_access_audit (
    id text COLLATE "C" PRIMARY KEY,
    grant_id text COLLATE "C" NOT NULL REFERENCES link_access_grants(id),
    from_owner text COLLATE "C" NOT NULL,
    to_owner text COLLATE "C" NOT NULL,
    scope text COLLATE "C" NOT NULL,
    action text COLLATE "C" NOT NULL,
    at text COLLATE "C" NOT NULL DEFAULT ov_now_iso()
);
CREATE INDEX IF NOT EXISTS idx_link_access_audit_owners ON link_access_audit(from_owner, to_owner, at);

CREATE TABLE IF NOT EXISTS agent_directory (
    id text COLLATE "C" PRIMARY KEY,
    owner_subject text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('actor','codes','link-local','chat-bot','service')),
    name text COLLATE "C" NOT NULL,
    service text COLLATE "C",
    machine_id text COLLATE "C" REFERENCES platform_node_principals(id),
    endpoint text COLLATE "C",
    skills text COLLATE "C" NOT NULL DEFAULT '[]',
    status text COLLATE "C" NOT NULL DEFAULT 'offline' CHECK (status IN ('online','busy','offline')),
    allow_others bigint NOT NULL DEFAULT 0 CHECK (allow_others IN (0, 1)),
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso()
);
CREATE INDEX IF NOT EXISTS idx_agent_directory_owner ON agent_directory(owner_subject, updated_at);

CREATE TABLE IF NOT EXISTS agent_threads (
    id text COLLATE "C" PRIMARY KEY,
    from_agent text COLLATE "C" NOT NULL REFERENCES agent_directory(id),
    to_agent text COLLATE "C" NOT NULL REFERENCES agent_directory(id),
    from_owner text COLLATE "C" NOT NULL,
    to_owner text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    last_answer_at text COLLATE "C",
    closes_at text COLLATE "C" NOT NULL,
    stopped_at text COLLATE "C"
);
CREATE INDEX IF NOT EXISTS idx_agent_threads_owners ON agent_threads(from_owner, to_owner, created_at);

CREATE TABLE IF NOT EXISTS agent_tasks (
    id text COLLATE "C" PRIMARY KEY,
    thread_id text COLLATE "C" NOT NULL REFERENCES agent_threads(id),
    from_agent text COLLATE "C" NOT NULL REFERENCES agent_directory(id),
    to_agent text COLLATE "C" NOT NULL REFERENCES agent_directory(id),
    on_behalf_of text COLLATE "C" NOT NULL,
    message text COLLATE "C" NOT NULL,
    skill_id text COLLATE "C",
    status text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','cancelled')),
    result text COLLATE "C",
    remote_id text COLLATE "C",
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso()
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_rate ON agent_tasks(from_agent, to_agent, created_at);
