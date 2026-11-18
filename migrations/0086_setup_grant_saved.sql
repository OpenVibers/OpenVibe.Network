-- phase: expand
-- A grant's save in two steps (the 11-15 review): used_at claims it before anything is written, so a replay finds
-- nothing; saved_at is set once every key is written, and save_failed_at (with save_error, a code, never a value) when
-- a write failed. Stop then never calls a save done while it is still running, or after it failed.
ALTER TABLE setup_grants ADD COLUMN IF NOT EXISTS saved_at timestamptz;
ALTER TABLE setup_grants ADD COLUMN IF NOT EXISTS save_failed_at timestamptz;
ALTER TABLE setup_grants ADD COLUMN IF NOT EXISTS save_error text COLLATE "C";
