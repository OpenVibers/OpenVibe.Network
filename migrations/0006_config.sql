-- phase: expand
-- plan T2. The revisioned-configuration journal (openvibe-shared/config on PostgreSQL): server/admin/site-config.js
-- keeps site_settings as what everything reads and records changes to them as revisions of the namespace
-- network.site_settings. config_snapshots and config_keys are openvibe-shared/config's configSchema(), which inlines
-- from that module's config-pg.js (a service's migrations own its tables; the runtime role creates none).

CREATE TABLE IF NOT EXISTS config_snapshots (
    namespace            text COLLATE "C" NOT NULL,
    revision             bigint NOT NULL,
    service              text COLLATE "C" NOT NULL,
    previous_revision    bigint,
    state                text COLLATE "C" NOT NULL CHECK (state IN ('proposed', 'active', 'superseded', 'rejected', 'rolled_back')),
    values_json          text COLLATE "C" NOT NULL,
    classification_json  text COLLATE "C" NOT NULL,
    values_checksum      text COLLATE "C" NOT NULL,
    created_at           text COLLATE "C" NOT NULL,
    created_by           text COLLATE "C" NOT NULL,
    activated_at         text COLLATE "C",
    activated_by         text COLLATE "C",
    reason               text COLLATE "C",
    error                text COLLATE "C",
    copied_from          bigint,
    good                 bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (namespace, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS config_snapshots_one_active ON config_snapshots (namespace) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS config_keys (
    namespace   text COLLATE "C" PRIMARY KEY,
    hmac_key    bytea NOT NULL,
    created_at  text COLLATE "C" NOT NULL
);
