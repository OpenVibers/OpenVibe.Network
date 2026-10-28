-- phase: expand
-- Quiet hours and email digests: a do-not-disturb window in each person's own zone, plus a per-category hourly/daily/weekly summary; additive, an older release never reads these.
CREATE TABLE IF NOT EXISTS notification_quiet_hours (
    user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled bigint NOT NULL DEFAULT 1,
    start_min integer NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
    end_min integer NOT NULL CHECK (end_min BETWEEN 0 AND 1439),
    tz text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" DEFAULT ov_now()
);

ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS digest text COLLATE "C" CHECK (digest IN ('off', 'hourly', 'daily', 'weekly'));

CREATE TABLE IF NOT EXISTS notification_digest_runs (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period text COLLATE "C" NOT NULL,
    last_sent_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (user_id, period)
);
