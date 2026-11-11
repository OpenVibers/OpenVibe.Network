-- phase: expand
-- People's own controls (make your own controls design, 2026-11-11, piece 4): one row per layout a
-- person made for a surface, ui.layout@1 as a JSON value. The active row per (person, surface, device)
-- is what a product reads; the rest are saved layouts. A share token makes one read-only without an
-- account, and `sharing` says private, link or gallery. The row is the person's own, so it goes into
-- their account export and is erased with them (ADR-033).
--
-- Expand only: an older release never reads this table, and nothing here changes an existing one.
CREATE TABLE IF NOT EXISTS ui_layouts (
    id text COLLATE "C" PRIMARY KEY,
    subject_id text COLLATE "C" NOT NULL,
    surface text COLLATE "C" NOT NULL,
    surface_version integer NOT NULL,
    device text COLLATE "C" NOT NULL CHECK (device IN ('phone', 'tablet', 'computer')),
    name text COLLATE "C" NOT NULL,
    doc jsonb NOT NULL,
    active boolean NOT NULL DEFAULT false,
    sharing text COLLATE "C" NOT NULL DEFAULT 'private' CHECK (sharing IN ('private', 'link', 'gallery')),
    share_token text COLLATE "C" UNIQUE,
    published_at timestamptz,
    revision bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- One active layout for a surface on a device class per person: setting another replaces it.
CREATE UNIQUE INDEX IF NOT EXISTS ui_layouts_one_active ON ui_layouts (subject_id, surface, device) WHERE active;
CREATE INDEX IF NOT EXISTS ui_layouts_by_subject ON ui_layouts (subject_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ui_layouts_gallery ON ui_layouts (surface, device, published_at DESC) WHERE sharing = 'gallery' AND published_at IS NOT NULL;
