-- phase: expand
-- The Companion may manage the person's OpenVibe.Mail masks (Seven Domains plan R2 item 12). The
-- browser extension holds a Dock token whose scope ceiling is this client's allowed_scopes; without
-- 'mail.mask.manage' in it, the Network refuses to grant the scope the extension asks for.
--
-- Expand only: the ceiling grows, nothing is taken away. The extension asks for the scope at its
-- next sign-in; a grant made before this stays as it was.
UPDATE oauth_clients
   SET allowed_scopes = 'dock activity chat.read agent.view mail.mask.manage'
 WHERE client_id = 'companion';
