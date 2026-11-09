-- phase: migrate
-- Forgejo served git.openvibe.codes until 2026-11-09; OpenVibe.Git (its own `git` client) replaced it. The `forgejo`
-- client keeps its row (consents and tokens may name it) but signs nobody in again: no redirect URI matches, and its
-- secret becomes one nobody holds. Nothing seeds it any more (server/db/database.js).
UPDATE oauth_clients
   SET redirect_uris = '[]', client_secret = md5(random()::text || clock_timestamp()::text)
 WHERE client_id = 'forgejo';
