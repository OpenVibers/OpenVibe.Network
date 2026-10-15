-- phase: expand
-- ADR-056: project secrets, per project and environment, written once and used by name. The value is only ever stored
-- encrypted (AES-256-GCM under NETWORK_SECRETS_KEY; key_id names the key, the row's identity is the authenticated data);
-- archiving a project shreds it (ciphertext, iv and tag set to NULL), the metadata stays for the audit. A grant lets one
-- service use one secret for sign and/or reveal (reveal only for the origins it lists). Additive: an older release never
-- reads these tables.
CREATE TABLE IF NOT EXISTS dev_project_secrets (
    project_id text COLLATE "C" NOT NULL REFERENCES dev_projects(id),
    environment text COLLATE "C" NOT NULL CHECK (environment IN ('sandbox', 'production')),
    name text COLLATE "C" NOT NULL,
    version bigint NOT NULL,
    key_id text COLLATE "C" NOT NULL,
    iv text COLLATE "C",
    tag text COLLATE "C",
    ciphertext text COLLATE "C",
    fingerprint text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL,
    created_by text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL,
    updated_by text COLLATE "C" NOT NULL,
    PRIMARY KEY (project_id, environment, name)
);

CREATE TABLE IF NOT EXISTS dev_project_secret_grants (
    project_id text COLLATE "C" NOT NULL,
    environment text COLLATE "C" NOT NULL,
    name text COLLATE "C" NOT NULL,
    service text COLLATE "C" NOT NULL,
    purposes text COLLATE "C" NOT NULL,
    origins text COLLATE "C" NOT NULL DEFAULT '[]',
    created_at text COLLATE "C" NOT NULL,
    created_by text COLLATE "C" NOT NULL,
    last_used_at text COLLATE "C",
    last_audit_day text COLLATE "C",
    PRIMARY KEY (project_id, environment, name, service),
    FOREIGN KEY (project_id, environment, name) REFERENCES dev_project_secrets(project_id, environment, name) ON DELETE CASCADE
);
