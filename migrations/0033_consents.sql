-- phase: expand
-- The consent registry (L24, data and AI by consent, 2026-10-31; Contracts 0.256.0 network.consent@1).
--
-- Nothing a person makes is off-limits to AI or data use by design: each use is off until that person turns it on
-- here. One row is one choice for one subject, purpose and client; a choice changed later (other kinds, another
-- licence, another feature set) is a NEW row and the old one is revoked, never edited. The record is the proof of
-- what was allowed, under which wording and when, so revoked rows are kept and never deleted.
--
-- `consent_events` is append-only: a trigger refuses UPDATE and DELETE. Account deletion revokes the active rows
-- (events by 'deletion') and keeps them; they hold no content.
--
-- Expand only: an older release never reads these tables, and nothing here changes an existing one.
CREATE TABLE IF NOT EXISTS consents (
    id text PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('ai.train', 'data.public', 'face.recognize', 'app.data')),
    kinds text[] NOT NULL DEFAULT '{}',
    client text,
    options jsonb NOT NULL DEFAULT '{}',
    text_version text NOT NULL,
    source text NOT NULL CHECK (source IN ('account', 'oauth', 'api', 'import:vision')),
    granted_at timestamptz NOT NULL,
    revoked_at timestamptz,
    revoked_by text,
    expires_at timestamptz,
    CHECK (subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CHECK (kinds <@ ARRAY['streams', 'vods', 'clips', 'voice', 'chat', 'posts', 'pictures', 'code']::text[]),
    CHECK (purpose <> 'face.recognize' OR kinds = '{}'),
    CHECK (client IS NULL OR client ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$'),
    CHECK (revoked_by IS NULL OR revoked_by IN ('person', 'app_revoked', 'merge', 'deletion', 'expired', 'import')),
    CHECK (text_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{1,3}$'),
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
-- One active choice per (subject, purpose, client): NULL (OpenVibe itself) and '' are the same slot.
CREATE UNIQUE INDEX IF NOT EXISTS consents_active
    ON consents (subject, purpose, COALESCE(client, ''))
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS consents_purpose_subject ON consents (purpose, subject);

CREATE TABLE IF NOT EXISTS consent_events (
    id bigserial PRIMARY KEY,
    consent_id text NOT NULL,
    subject text COLLATE "C" NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('ai.train', 'data.public', 'face.recognize', 'app.data')),
    client text,
    action text NOT NULL CHECK (action IN ('granted', 'revoked', 'expired')),
    "by" text NOT NULL CHECK ("by" IN ('person', 'app_revoked', 'merge', 'deletion', 'import')),
    text_version text NOT NULL,
    at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS consent_events_subject ON consent_events (subject, id DESC);
CREATE INDEX IF NOT EXISTS consent_events_consent ON consent_events (consent_id, id);

-- Append-only: nothing updates or deletes a consent event, ever. The history is the proof of the choices.
CREATE OR REPLACE FUNCTION consent_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'consent_events is append-only';
END $$;
DROP TRIGGER IF EXISTS consent_events_no_change ON consent_events;
CREATE TRIGGER consent_events_no_change BEFORE UPDATE OR DELETE ON consent_events
    FOR EACH ROW EXECUTE FUNCTION consent_events_append_only();
