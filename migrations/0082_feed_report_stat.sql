-- phase: expand
-- The Report card's moment and side numbers (the owner, 11-14: "show the time based on the user's computer" and "add
-- total users per day or other cool metrics to the card showing peak today"). feed.item@1 1.2.0 `stat`: when the
-- number happened (each reader's own clock says the time) and up to six side numbers (people today, signed in, …).
--
-- feed_peaks keeps the day's distinct people beside its peak: signed-in people and guests seen that UTC day
-- (server/frame/seen.js counts them in memory; the larger count wins, so a restart never lowers it).
--
-- Expand only: an older release never reads these columns, and nothing here changes an existing row.
ALTER TABLE feed_items ADD COLUMN IF NOT EXISTS stat jsonb;
ALTER TABLE feed_peaks ADD COLUMN IF NOT EXISTS members_day integer NOT NULL DEFAULT 0 CHECK (members_day >= 0);
ALTER TABLE feed_peaks ADD COLUMN IF NOT EXISTS guests_day integer NOT NULL DEFAULT 0 CHECK (guests_day >= 0);
