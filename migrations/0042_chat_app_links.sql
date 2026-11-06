-- phase: expand
-- Connect identities for the chat bots. Provider ids are namespaced by workspace for Slack.
-- These are Connect account links, not OAuth sign-in providers. Slack's service key includes its workspace.
--
-- Linking is two-way (plan A4 security review). /link makes a pending row; the person confirms it
-- while signed in here, which mints a 6-digit code kept only as a hash; the link is written only
-- when the SAME chat account that started /link sends that code to the bot. A confirm URL sent to
-- somebody else therefore links nothing.
CREATE UNIQUE INDEX linked_chat_identity ON linked_accounts(service, service_user_id) WHERE service LIKE 'chat:%';
CREATE TABLE chat_app_pending_links (
    token_hash text PRIMARY KEY,
    app text NOT NULL CHECK (app IN ('telegram', 'discord', 'slack')),
    external_id text NOT NULL,
    label text,
    bot_handle text,
    expires_at text NOT NULL,
    confirmed_by bigint REFERENCES users(id) ON DELETE CASCADE,
    confirmed_at text,
    code_hash text,
    code_expires_at text,
    attempts integer NOT NULL DEFAULT 0,
    finished_at text,
    cancelled_at text
);
CREATE INDEX chat_app_pending_links_identity ON chat_app_pending_links (app, external_id);
