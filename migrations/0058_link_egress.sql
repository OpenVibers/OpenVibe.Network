-- phase: expand
-- Expand only. 0057 is reserved by the open Companion blind-fill PR.
CREATE TABLE link_egress_settings (
    owner_subject TEXT PRIMARY KEY,
    egress_via_link BOOLEAN NOT NULL DEFAULT true,
    offline_choice TEXT NOT NULL DEFAULT 'openvibe' CHECK (offline_choice IN ('openvibe', 'wait')),
    monthly_bytes BIGINT NOT NULL DEFAULT 20000000000 CHECK (monthly_bytes BETWEEN 0 AND 10000000000000),
    excluded_sites JSONB NOT NULL DEFAULT '[]'
);
CREATE TABLE link_egress_devices (
    node_id TEXT PRIMARY KEY REFERENCES platform_node_principals(id),
    relay_url TEXT NOT NULL,
    checked_at BIGINT NOT NULL
);
CREATE TABLE link_egress_sessions (
    session_id TEXT PRIMARY KEY,
    owner_subject TEXT NOT NULL,
    machine TEXT NOT NULL,
    desk TEXT NOT NULL,
    node_id TEXT REFERENCES platform_node_principals(id),
    credential_hash TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    ended BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (machine, desk)
);
CREATE INDEX link_egress_sessions_expiry ON link_egress_sessions(expires_at);
