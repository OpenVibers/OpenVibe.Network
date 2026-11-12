-- phase: expand
-- One feed for all of OpenVibe (feed.item@1): the items Network gathers from OpenVibe.Events and the
-- sites' public APIs, the state of each collector, and the daily online peak the Report card reads.
--
-- Expand only: an older release never reads these tables, and nothing here changes an existing one.
-- The feed keeps only public or follower-visible activity; actor_subject is the person the item is
-- about (null for AI, system and aggregate rows), never a copy of their profile.
CREATE TABLE IF NOT EXISTS feed_items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_service text COLLATE "C" NOT NULL,
    source_type text COLLATE "C" NOT NULL,
    source_id text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL,
    title text COLLATE "C" NOT NULL,
    text text COLLATE "C",
    url text COLLATE "C" NOT NULL,
    site text COLLATE "C" NOT NULL,
    site_name text COLLATE "C" NOT NULL,
    actor_subject text COLLATE "C",
    actor_name text COLLATE "C",
    origin text COLLATE "C" NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'ai', 'system')),
    visibility text COLLATE "C" NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'followers')),
    picture_url text COLLATE "C",
    preview_url text COLLATE "C",
    media_ratio double precision,
    media_length bigint,
    counts jsonb NOT NULL DEFAULT '{}'::jsonb,
    live_now boolean NOT NULL DEFAULT false,
    trend jsonb,
    label text COLLATE "C",
    starts_at timestamptz,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_service, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS feed_items_recent ON feed_items (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS feed_items_actor ON feed_items (actor_subject, occurred_at DESC);
CREATE INDEX IF NOT EXISTS feed_items_kind ON feed_items (kind, occurred_at DESC);

-- One row per collector: when it ran and when it is due next, so a restart does not skip a source and
-- two processes never both fetch one (the second finds it not due).
CREATE TABLE IF NOT EXISTS feed_source_runs (
    name text COLLATE "C" PRIMARY KEY,
    next_run_at timestamptz NOT NULL,
    last_run_at timestamptz NOT NULL,
    last_error text COLLATE "C"
);

-- Small key/value state: the Events pull cursor, the last online peak sampled, the last report card.
CREATE TABLE IF NOT EXISTS feed_state (
    key text COLLATE "C" PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- The network's online peak per UTC day (members seen in the last thirty minutes plus distinct guests,
-- server/frame/seen.js). The Report card says the day's peak and the hour it happened.
CREATE TABLE IF NOT EXISTS feed_peaks (
    day date PRIMARY KEY,
    peak integer NOT NULL CHECK (peak >= 0),
    peak_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- A source that names a channel (Live) or a forum author by handle: the one person Network knows by it,
-- so the Following filter and the "watched together" summary can name them. Never more than one match.
CREATE TABLE IF NOT EXISTS feed_channel_people (
    handle text COLLATE "C" PRIMARY KEY,
    subject_id text COLLATE "C" NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- When a person's Quest badges were last checked (the public badges API is the only read Quest offers,
-- so the feed checks people recently active in it, at most once a day each).
CREATE TABLE IF NOT EXISTS feed_quest_people (
    subject text COLLATE "C" PRIMARY KEY,
    checked_at timestamptz NOT NULL DEFAULT now()
);
