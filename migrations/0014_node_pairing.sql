-- phase: expand
-- plan T2. A paired machine's principal gains its owner, the credential that pairs it and its pairing record.

ALTER TABLE platform_node_principals
    ADD COLUMN IF NOT EXISTS owner_subject        text COLLATE "C",
    ADD COLUMN IF NOT EXISTS name                 text COLLATE "C" CHECK (length(name) BETWEEN 1 AND 80),
    ADD COLUMN IF NOT EXISTS credential_hash      text COLLATE "C" CHECK (credential_hash ~ '^[0-9a-f]{64}$'),
    ADD COLUMN IF NOT EXISTS credential_prev_hash text COLLATE "C" CHECK (credential_prev_hash ~ '^[0-9a-f]{64}$'),
    ADD COLUMN IF NOT EXISTS prev_valid_until     text COLLATE "C",
    ADD COLUMN IF NOT EXISTS paired_by_service    text COLLATE "C" CHECK (paired_by_service ~ '^[a-z][a-z0-9-]{1,39}$'),
    ADD COLUMN IF NOT EXISTS pairing_ref          text COLLATE "C" CHECK (length(pairing_ref) BETWEEN 1 AND 80),
    ADD COLUMN IF NOT EXISTS last_seen_at         text COLLATE "C";

ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_owner;
ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_owner CHECK (
       (owner_kind = 'platform' AND project_id IS NULL AND owner_subject IS NULL AND trust = 'first-party')
    OR (owner_kind = 'project' AND project_id IS NOT NULL AND owner_subject IS NULL AND trust <> 'first-party')
    OR (owner_kind = 'user' AND project_id IS NULL AND owner_subject IS NOT NULL
        AND owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$' AND trust = 'community'));
ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_owner_kind_check;
ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_owner_kind_check
    CHECK (owner_kind IN ('platform', 'project', 'user'));
-- A paired machine always holds a credential; a platform machine reported by Host holds none (yet).
ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_credential;
ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_credential
    CHECK (owner_kind = 'platform' OR credential_hash IS NOT NULL) NOT VALID;
ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_prev;
ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_prev
    CHECK ((credential_prev_hash IS NULL) = (prev_valid_until IS NULL));
ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_paired;
ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_paired
    CHECK ((paired_by_service IS NULL) = (pairing_ref IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS platform_node_principals_credential_idx ON platform_node_principals (credential_hash)
    WHERE status <> 'revoked' AND credential_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_node_principals_prev_idx ON platform_node_principals (credential_prev_hash)
    WHERE status <> 'revoked' AND credential_prev_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_node_principals_user_idx ON platform_node_principals (owner_subject) WHERE owner_subject IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_node_principals_paired_idx ON platform_node_principals (paired_by_service, pairing_ref) WHERE paired_by_service IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_node_pairings (
    id            text COLLATE "C" PRIMARY KEY CHECK (id ~ '^pair_[0-9A-HJKMNP-TV-Z]{26}$'),
    code_hash     text COLLATE "C" NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    owner_kind    text COLLATE "C" NOT NULL CHECK (owner_kind IN ('project', 'user')),
    project_id    text COLLATE "C" REFERENCES dev_projects(id),
    owner_subject text COLLATE "C",
    service       text COLLATE "C" NOT NULL CHECK (service ~ '^[a-z][a-z0-9-]{1,39}$'),
    ref           text COLLATE "C" NOT NULL CHECK (length(ref) BETWEEN 1 AND 80),
    home_cell     text COLLATE "C" REFERENCES platform_cells(id),
    created_by    text COLLATE "C" NOT NULL,
    created_at    text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    expires_at    text COLLATE "C" NOT NULL,
    tries         integer NOT NULL DEFAULT 0 CHECK (tries BETWEEN 0 AND 5),
    used_at       text COLLATE "C",
    principal_id  text COLLATE "C" REFERENCES platform_node_principals(id),
    CONSTRAINT platform_node_pairings_owner CHECK (
           (owner_kind = 'project' AND project_id IS NOT NULL AND owner_subject IS NULL)
        OR (owner_kind = 'user' AND project_id IS NULL AND owner_subject IS NOT NULL
            AND owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$')),
    CONSTRAINT platform_node_pairings_used CHECK (principal_id IS NULL OR used_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS platform_node_pairings_ref_idx ON platform_node_pairings (service, ref, created_at);

CREATE TABLE IF NOT EXISTS platform_node_capabilities (
    node_id       text COLLATE "C" PRIMARY KEY REFERENCES platform_node_principals(node_id),
    doc           text COLLATE "C" NOT NULL,
    reported_at   text COLLATE "C" NOT NULL
);
