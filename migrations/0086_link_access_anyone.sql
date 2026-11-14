-- phase: expand
-- "Anyone may ask" (11-14, the owner: a machine's sharing is for all users): with it on, anyone signed in to OpenVibe
-- may ask to use the machine, not only people its owner follows. Off by default; others_may_ask must be on too. The
-- owner still answers each request, and the daily limit and the day-long wait after a refusal still hold.
ALTER TABLE link_access_settings ADD COLUMN IF NOT EXISTS anyone_may_ask bigint NOT NULL DEFAULT 0 CHECK (anyone_may_ask IN (0, 1));
