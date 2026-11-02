-- phase: expand
-- One look everywhere (plan L42, openvibe-shared 4.64.0; the owner, 10-31: seasonal turned off on Network was still on,
-- and orange, on Live). Every copy of a person's look is dated, and the newest wins: these say when the account's copy
-- was chosen (ms since the epoch, the browser's own clock for display settings), so an older copy arriving from a
-- stale tab no longer undoes a newer choice, and a site can tell its own copy is out of date. Null for choices made
-- before this release; an older release never reads them.
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS display_at bigint;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS theme_at bigint;
