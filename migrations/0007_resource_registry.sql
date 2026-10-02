-- phase: expand
-- plan T2. The resource registry (docs/t2-resource-registry.md): what the network can place on, one
-- platform.resource-offer@1 per row, reported by the component that owns it (server/registry/offers.js). doc is the
-- verbatim contract document; kind, region, cell, trust, status and price_usd are copied out of it by the mapping in
-- the design's section 2 so that filters run in SQL. kind is exactly the enum the pinned contract (Contracts 0.83.0)
-- defines; it is widened only together with the contract (0008, slice 5).

CREATE TABLE IF NOT EXISTS platform_resource_offers (
    id            text COLLATE "C" PRIMARY KEY,
    source        text COLLATE "C" NOT NULL,
    kind          text COLLATE "C" NOT NULL CHECK (kind IN ('node', 'provider')),
    region        text COLLATE "C" NOT NULL,
    cell          text COLLATE "C" NOT NULL DEFAULT 'wnam-1',
    trust         text COLLATE "C" NOT NULL CHECK (trust IN ('first-party', 'partner', 'community', 'external')),
    status        text COLLATE "C" NOT NULL CHECK (status IN ('up', 'degraded', 'down', 'draining')),
    price_usd     double precision NOT NULL DEFAULT 0,
    doc           text COLLATE "C" NOT NULL,
    reported_at   text COLLATE "C" NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_resource_offers_source_idx ON platform_resource_offers (source, status);
CREATE INDEX IF NOT EXISTS platform_resource_offers_kind_idx ON platform_resource_offers (kind, region, status);
