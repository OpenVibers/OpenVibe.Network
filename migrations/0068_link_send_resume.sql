-- phase: expand
-- Link Send v2: a transfer can be uploaded in parts and resumed after a dropped connection, and the sender can see
-- whether the receiving machine accepted, declined or saved it. The relay still stores only Locker ciphertext.
ALTER TABLE link_send_items ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE link_send_items ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE link_send_items ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE TABLE IF NOT EXISTS link_send_uploads (
    id text PRIMARY KEY,
    owner_subject text NOT NULL REFERENCES users(subject_id) ON DELETE CASCADE,
    sender_node text REFERENCES platform_node_principals(id) ON DELETE CASCADE,
    target_node text NOT NULL REFERENCES platform_node_principals(id) ON DELETE CASCADE,
    bytes bigint NOT NULL CHECK (bytes > 0),
    received bigint NOT NULL DEFAULT 0 CHECK (received >= 0),
    item_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS link_send_uploads_owner ON link_send_uploads (owner_subject, expires_at);

CREATE TABLE IF NOT EXISTS link_send_chunks (
    upload_id text NOT NULL REFERENCES link_send_uploads(id) ON DELETE CASCADE,
    seq integer NOT NULL,
    body text NOT NULL,
    bytes integer NOT NULL,
    PRIMARY KEY (upload_id, seq)
);

-- Direct delivery on the same LAN: each machine advertises its own endpoint, and the owner's machines share a secret
-- that authenticates a sender without a round trip through OpenVibe. The relay never needs to be in the path.
ALTER TABLE link_send_keys ADD COLUMN IF NOT EXISTS lan jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS link_send_owner_secrets (
    owner_subject text PRIMARY KEY REFERENCES users(subject_id) ON DELETE CASCADE,
    secret text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
