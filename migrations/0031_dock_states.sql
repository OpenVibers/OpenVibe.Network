-- phase: expand
-- The Dock's state per person (the Dock plan 2026-10-30, K-D1): the little floating surface every OpenVibe site
-- draws — your agent, your chats, your activity. It is drawn on many domains and localStorage is per site, so the
-- state it follows you with lives here, in the Network.
--
-- One row per person: the state is network.dock-state@1 (Contracts 0.251.0) as a JSON value. The row is the
-- person's own, so it goes into their account export and is erased with them (ADR-033), and a merge (ADR-029)
-- leaves it with the surviving account.
--
-- Expand only: an older release never reads this table, and nothing here changes an existing one.
CREATE TABLE IF NOT EXISTS dock_states (
    subject text COLLATE "C" PRIMARY KEY,
    state jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
