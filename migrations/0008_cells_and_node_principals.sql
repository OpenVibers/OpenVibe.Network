-- phase: expand
-- plan T2. Cells now, hardware later (docs/t2-resource-registry.md section 9): regions, cells, node principals and
-- service instances on today's single host, with the one cell wnam-1 in us-west seeded here. A node principal is the
-- Network identity of a machine (nod_<ULID>): who owns it (the platform, or a developer project), its trust class and
-- its home cell are assigned by Network and never taken from a report. Service instances run on a registered node in
-- that node's home cell. Projects gain a home cell (backfilled to wnam-1). The offers of 0007 must name a known cell;
-- the constraint is NOT VALID so rows written before it are not re-checked.

CREATE TABLE IF NOT EXISTS platform_regions (
    id            text COLLATE "C" PRIMARY KEY CHECK (id ~ '^[a-z]{2}-[a-z]+(-[0-9])?$'),
    country       text COLLATE "C" NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
    created_at    text COLLATE "C" NOT NULL DEFAULT ov_now_iso()
);

CREATE TABLE IF NOT EXISTS platform_cells (
    id            text COLLATE "C" PRIMARY KEY CHECK (id ~ '^[a-z]{2,8}-[0-9]{1,3}$'),
    region        text COLLATE "C" NOT NULL REFERENCES platform_regions(id),
    residency     text COLLATE "C" NOT NULL CHECK (residency ~ '^[A-Z]{2}$'),
    status        text COLLATE "C" NOT NULL CHECK (status IN ('planned', 'active', 'draining', 'retired')),
    route_weight  integer NOT NULL DEFAULT 100 CHECK (route_weight BETWEEN 0 AND 1000),
    created_at    text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    updated_at    text COLLATE "C" NOT NULL DEFAULT ov_now_iso()
);

INSERT INTO platform_regions (id, country) VALUES ('us-west', 'US') ON CONFLICT DO NOTHING;
INSERT INTO platform_cells (id, region, residency, status) VALUES ('wnam-1', 'us-west', 'US', 'active') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_node_principals (
    id            text COLLATE "C" PRIMARY KEY CHECK (id ~ '^nod_[0-9A-HJKMNP-TV-Z]{26}$'),
    node_id       text COLLATE "C" NOT NULL UNIQUE CHECK (node_id ~ '^[a-z][a-z0-9-]{1,39}$'),
    home_cell     text COLLATE "C" NOT NULL REFERENCES platform_cells(id),
    owner_kind    text COLLATE "C" NOT NULL CHECK (owner_kind IN ('platform', 'project')),
    project_id    text COLLATE "C" REFERENCES dev_projects(id),
    trust         text COLLATE "C" NOT NULL CHECK (trust IN ('first-party', 'partner', 'community', 'external')),
    status        text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draining', 'revoked')),
    created_at    text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    created_by    text COLLATE "C" NOT NULL,
    updated_at    text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    revoked_at    text COLLATE "C",
    revoked_by    text COLLATE "C",
    -- Only the platform's own machines are first-party; every other machine belongs to exactly one project.
    CONSTRAINT platform_node_principals_owner CHECK (
        (owner_kind = 'platform' AND project_id IS NULL AND trust = 'first-party')
        OR (owner_kind = 'project' AND project_id IS NOT NULL AND trust <> 'first-party')),
    CONSTRAINT platform_node_principals_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
    CONSTRAINT platform_node_principals_node_cell UNIQUE (node_id, home_cell)
);
CREATE INDEX IF NOT EXISTS platform_node_principals_cell_idx ON platform_node_principals (home_cell, status);
CREATE INDEX IF NOT EXISTS platform_node_principals_project_idx ON platform_node_principals (project_id) WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_service_instances (
    id            text COLLATE "C" PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
    service       text COLLATE "C" NOT NULL CHECK (service ~ '^[a-z][a-z0-9-]{1,39}$'),
    version       text COLLATE "C" NOT NULL,
    cell          text COLLATE "C" NOT NULL,
    node_id       text COLLATE "C" NOT NULL,
    endpoints     text COLLATE "C" NOT NULL DEFAULT '[]',
    state         text COLLATE "C" NOT NULL CHECK (state IN ('starting', 'ready', 'degraded', 'draining', 'stopped')),
    route_weight  integer NOT NULL DEFAULT 100 CHECK (route_weight BETWEEN 0 AND 1000),
    source        text COLLATE "C" NOT NULL,
    started_at    text COLLATE "C" NOT NULL,
    reported_at   text COLLATE "C" NOT NULL,
    -- An instance runs on a registered node, in that node's home cell.
    CONSTRAINT platform_service_instances_node FOREIGN KEY (node_id, cell) REFERENCES platform_node_principals (node_id, home_cell)
);
CREATE INDEX IF NOT EXISTS platform_service_instances_cell_idx ON platform_service_instances (cell, service, state);

ALTER TABLE dev_projects ADD COLUMN IF NOT EXISTS home_cell text COLLATE "C" NOT NULL DEFAULT 'wnam-1' REFERENCES platform_cells(id);

ALTER TABLE platform_resource_offers ADD CONSTRAINT platform_resource_offers_cell FOREIGN KEY (cell) REFERENCES platform_cells(id) NOT VALID;
