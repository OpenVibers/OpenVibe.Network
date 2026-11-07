-- phase: expand
-- Whether a refresh family is a session family (OpenVibe Link's sign-in through the https App Link, plan 2026-11-07
-- §13.2). The kind is decided once, when the code is exchanged: a family started through openvibe-link://auth — a
-- scheme any app can claim — must never become a session on a later refresh. 0 keeps every family a Dock family,
-- which is what every row written before this column is.
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS session_family bigint DEFAULT 0;
