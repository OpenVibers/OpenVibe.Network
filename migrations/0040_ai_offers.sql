-- phase: expand
-- Community AI offers (the design's "Offer to the network"; plan E4). A Node ai plugin advertises one machine's local
-- models, hours, concurrency, credit price and audience; Bot reports the complete set for source `bot`; AI reads it
-- internally with network.registry.read and places only opted-in requests on a verified machine. This is its own table,
-- not platform_resource_offers, because platform.resource-offer@1's detail slot is closed for kind node/provider and a
-- community model offer has fields the generic contract cannot carry. It is still a user-owned offer: owner_subject is
-- required, the public API never lists it, and only services holding network.registry.read can read it whole.
CREATE TABLE IF NOT EXISTS platform_ai_offers (
    id              text COLLATE "C" PRIMARY KEY,      -- ai:<device id>
    source          text COLLATE "C" NOT NULL,         -- bot
    machine_id      text COLLATE "C" NOT NULL,
    owner_subject   text COLLATE "C" NOT NULL,
    models          jsonb NOT NULL,
    hours           jsonb NOT NULL,
    concurrency     integer NOT NULL CHECK (concurrency BETWEEN 1 AND 8),
    price_in        numeric(20, 6) NOT NULL CHECK (price_in >= 0),
    price_out       numeric(20, 6) NOT NULL CHECK (price_out >= 0),
    audience        text COLLATE "C" NOT NULL CHECK (audience IN ('everyone', 'followers', 'group')),
    group_id        text COLLATE "C",
    ready           boolean NOT NULL DEFAULT false,
    status          text COLLATE "C" NOT NULL DEFAULT 'up' CHECK (status IN ('up', 'degraded', 'down')),
    doc             text COLLATE "C" NOT NULL,
    reported_at     timestamptz NOT NULL,
    updated_at      timestamptz NOT NULL,
    CHECK (audience <> 'group' OR (group_id IS NOT NULL AND group_id <> '')),
    CHECK (owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$')
);
CREATE INDEX IF NOT EXISTS platform_ai_offers_source ON platform_ai_offers (source, status);
CREATE INDEX IF NOT EXISTS platform_ai_offers_owner ON platform_ai_offers (owner_subject, updated_at DESC);
