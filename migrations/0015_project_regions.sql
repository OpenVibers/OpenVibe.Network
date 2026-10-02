-- phase: expand
-- plan T2. Project placement (docs/t2-cells-and-node-principal.md section 3.1, slice N3): a project's preferred
-- regions, in preference order, as a JSON array of platform_regions.id (at most 5, unique). An array cannot carry a
-- foreign key, so server/developer/store.js validates every id against platform_regions in the same transaction.
-- dev_projects already has home_cell (0008); a project's residency is its home cell's and gets no column (decision A:
-- one source of truth), it is derived on read. text, not jsonb, as every other JSON column here.

ALTER TABLE dev_projects ADD COLUMN IF NOT EXISTS preferred_regions text COLLATE "C" NOT NULL DEFAULT '[]'
    CHECK (preferred_regions LIKE '[%]');
