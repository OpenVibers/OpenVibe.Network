-- phase: expand
-- Companion approval uses a separate user token scope; existing families keep their old scope until re-sign-in.
UPDATE oauth_clients SET allowed_scopes = concat(allowed_scopes, ' run.fill.approve')
WHERE client_id = 'companion' AND position('run.fill.approve' in allowed_scopes) = 0;
