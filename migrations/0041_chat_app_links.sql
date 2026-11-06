-- phase: expand
-- Connect identities for the chat bots. Provider ids are namespaced by workspace for Slack.
-- These are Connect account links, not OAuth sign-in providers. Slack's service key includes its workspace.
CREATE UNIQUE INDEX linked_chat_identity ON linked_accounts(service, service_user_id) WHERE service LIKE 'chat:%';
CREATE TABLE chat_app_pending_links (
    token_hash text PRIMARY KEY,
    app text NOT NULL CHECK (app IN ('telegram', 'discord', 'slack')),
    external_id text NOT NULL,
    label text,
    expires_at text NOT NULL,
    confirmed_by bigint REFERENCES users(id) ON DELETE CASCADE,
    confirmed_at text
);
