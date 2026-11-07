-- phase: expand
-- The shared menu's anonymous click counts (plan 2026-10-22, track W; Shared 4.128.0 sends the beacon).
-- One row per day, section, destination site and position bucket; no person, page or cookie is stored.
CREATE TABLE IF NOT EXISTS menu_clicks (
    day text COLLATE "C" NOT NULL,
    section text COLLATE "C" NOT NULL,
    to_site text COLLATE "C" NOT NULL,
    pos_bucket text COLLATE "C" NOT NULL,
    n bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (day, section, to_site, pos_bucket)
);
