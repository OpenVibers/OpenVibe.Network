-- phase: expand
-- plan T2 WS-Z2. Agents (docs/t2-projects-and-grants.md section 3, slice 2): an agent (agt_<ULID>) acts for one
-- person, inside one developer project, run by one host: an app of that project in the same environment, or a
-- first-party service (always production). The composite foreign key makes a host app of another project or
-- environment impossible; dev_apps.id is already the primary key, so the unique index only gives it a target.
-- revoked is final, paused is the owner's reversible kill switch. Numbered after 0015: the runner refuses a file
-- older than one already applied, so the design's 0010 could never reach a database at 0014 or later.

CREATE UNIQUE INDEX IF NOT EXISTS dev_apps_project_env_key ON dev_apps (id, project_id, environment);

CREATE TABLE IF NOT EXISTS dev_agents (
    id             text COLLATE "C" PRIMARY KEY CHECK (id ~ '^agt_[0-9A-HJKMNP-TV-Z]{26}$'),
    project_id     text COLLATE "C" NOT NULL REFERENCES dev_projects(id),
    owner_subject  text COLLATE "C" NOT NULL CHECK (owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    host_kind      text COLLATE "C" NOT NULL CHECK (host_kind IN ('app', 'service')),
    host_app_id    text COLLATE "C",
    host_service   text COLLATE "C" REFERENCES oauth_clients(client_id),
    environment    text COLLATE "C" NOT NULL CHECK (environment IN ('sandbox', 'production')),
    name           text COLLATE "C" NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    status         text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
    created_at     text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    created_by     text COLLATE "C" NOT NULL,
    updated_at     text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    revoked_at     text COLLATE "C",
    revoked_by     text COLLATE "C",
    FOREIGN KEY (host_app_id, project_id, environment) REFERENCES dev_apps (id, project_id, environment),
    CHECK ((host_kind = 'app') = (host_app_id IS NOT NULL)),
    CHECK ((host_kind = 'service') = (host_service IS NOT NULL)),
    CHECK (host_kind = 'app' OR environment = 'production'),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS dev_agents_project_idx ON dev_agents (project_id, status);
CREATE INDEX IF NOT EXISTS dev_agents_owner_idx   ON dev_agents (owner_subject, status);
CREATE INDEX IF NOT EXISTS dev_agents_app_idx     ON dev_agents (host_app_id) WHERE host_app_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dev_agents_service_idx ON dev_agents (host_service) WHERE host_service IS NOT NULL;
