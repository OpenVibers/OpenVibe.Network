-- phase: expand
-- Presence (plan 2026-10-22 track X item 9): one person's chosen online status, the heartbeat that says
-- they are around, and the public view last announced to OpenVibe.Events. Network owns it; Chat and the
-- navbar read it through GET /api/v1/presence (or GET /internal/presence with network.presence.read).
--
-- The derived state is not stored: online while last_heartbeat_at is under 2 minutes old, away after 10
-- minutes without input (last_active_at; an idle heartbeat leaves it alone), offline after 3 minutes
-- without a heartbeat. state is the person's chosen state; invisible and show_status = 0 read as offline.
-- announced_* is the public view in the last network.presence.changed event, so a change inside the 30 s
-- debounce sets pending_since and the flusher sends the view that stands when the window opens.
CREATE TABLE IF NOT EXISTS person_presence (
    subject_id text COLLATE "C" PRIMARY KEY REFERENCES users(subject_id) ON DELETE CASCADE,
    state text COLLATE "C" NOT NULL DEFAULT 'auto' CHECK (state IN ('auto', 'dnd', 'invisible')),
    status_text text COLLATE "C",
    emoji text COLLATE "C",
    show_status bigint NOT NULL DEFAULT 1 CHECK (show_status IN (0, 1)),
    last_active_at text COLLATE "C",
    last_heartbeat_at text COLLATE "C",
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    announced_state text COLLATE "C",
    announced_status_text text COLLATE "C",
    announced_emoji text COLLATE "C",
    announced_live bigint,
    announced_at text COLLATE "C",
    pending_since text COLLATE "C"
);

CREATE INDEX IF NOT EXISTS person_presence_pending ON person_presence(pending_since) WHERE pending_since IS NOT NULL;
