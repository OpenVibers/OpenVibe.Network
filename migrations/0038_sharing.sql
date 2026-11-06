-- phase: expand
-- Sharing on OpenVibe (design 2026-11-06, SHARING-DESIGN-2026-11-06.md, section 4 "Network"):
-- Network's own record of what is shared with whom, built from the share events over OpenVibe.Events
-- (share.granted, share.revoked, share.transfer.*). The owning service stays the authority on access
-- (its own canView decides); these rows are Network's index for the "Shared with me" list, the
-- notification texts and the share picker's suggestions.
--
-- Timestamps are ISO-8601 UTC strings ("2026-11-06T09:12:00.000Z"), so comparisons stay lexical on
-- PostgreSQL and PGlite, like the rest of the newer tables.
CREATE TABLE share_grants (
    id text COLLATE "C" PRIMARY KEY,
    recipient_subject text COLLATE "C" NOT NULL,
    owner_subject text COLLATE "C" NOT NULL,
    service text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL,
    item_id text COLLATE "C" NOT NULL,
    role text COLLATE "C" NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor')),
    expires_at text COLLATE "C",
    granted_at text COLLATE "C" NOT NULL,
    revoked_at text COLLATE "C",
    event_id text COLLATE "C"
);
-- One live membership per item and person: a second grant for the same item updates the row.
CREATE UNIQUE INDEX share_grants_item ON share_grants (recipient_subject, service, kind, item_id);
CREATE INDEX share_grants_recipient ON share_grants (recipient_subject, revoked_at, granted_at);
CREATE INDEX share_grants_owner ON share_grants (owner_subject, granted_at);

-- Ownership transfers: pending until the recipient accepts or declines, then the answer.
CREATE TABLE share_transfers (
    id text COLLATE "C" PRIMARY KEY,
    service text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL,
    item_id text COLLATE "C" NOT NULL,
    from_subject text COLLATE "C" NOT NULL,
    to_subject text COLLATE "C" NOT NULL,
    keep_access integer NOT NULL DEFAULT 0,
    state text COLLATE "C" NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
    requested_at text COLLATE "C" NOT NULL,
    expires_at text COLLATE "C",
    answered_at text COLLATE "C",
    event_id text COLLATE "C"
);
CREATE INDEX share_transfers_to ON share_transfers (to_subject, state, requested_at);
CREATE INDEX share_transfers_from ON share_transfers (from_subject, state, requested_at);

-- The @name checks of the share picker, counted per person: nobody may walk the network's accounts.
CREATE TABLE share_name_checks (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text COLLATE "C" NOT NULL,
    checked_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso()
);
CREATE INDEX share_name_checks_user_time ON share_name_checks (user_id, checked_at);
