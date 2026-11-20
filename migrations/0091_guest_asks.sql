-- phase: expand
-- A signed-out visitor's questions from the menu's box, counted by day (server/frame/guest-ask.js, 2026-11-20): per
-- guest and per address (keyed hashes, never the id or the address in the clear) and for all guests ('all', '*'),
-- with what the answers cost, for the daily guest budget.
CREATE TABLE IF NOT EXISTS guest_asks (
    day text NOT NULL,
    scope text NOT NULL,
    key text NOT NULL,
    n integer NOT NULL DEFAULT 0,
    cost_usd double precision NOT NULL DEFAULT 0,
    PRIMARY KEY (day, scope, key)
);
