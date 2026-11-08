-- phase: expand
-- Link Send v1 relays only Locker ciphertext between a person's own paired machines.
CREATE TABLE IF NOT EXISTS link_send_items (
    id text PRIMARY KEY,
    owner_subject text NOT NULL REFERENCES users(subject_id) ON DELETE CASCADE,
    sender_node text REFERENCES platform_node_principals(id) ON DELETE CASCADE,
    target_node text NOT NULL REFERENCES platform_node_principals(id) ON DELETE CASCADE,
    envelope text NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'declined')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS link_send_target_pending ON link_send_items (target_node, created_at)
    WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS link_send_expiry ON link_send_items (expires_at);

CREATE TABLE IF NOT EXISTS link_send_keys (
    node_id text PRIMARY KEY REFERENCES platform_node_principals(id) ON DELETE CASCADE,
    public_key jsonb NOT NULL,
    key_thumbprint text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
