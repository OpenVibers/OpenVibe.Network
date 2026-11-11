-- phase: expand
-- Ask 273: the person's own read state for channel points ("since I last looked" per channel).
-- One row per person per streamer: the Live channel_points_log id the bar has already shown.
-- The id names a row in Live's database, so there is no foreign key to it.
CREATE TABLE IF NOT EXISTS channel_points_reads (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    streamer_id bigint NOT NULL,
    last_seen_tx bigint NOT NULL,
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now(),
    PRIMARY KEY (user_id, streamer_id)
);
