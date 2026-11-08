-- phase: expand
-- Existing grants stay unchanged; the person signs in again to grant Locker access.
UPDATE oauth_clients SET allowed_scopes = concat(allowed_scopes, ' locker.login.manage')
WHERE client_id = 'companion' AND position('locker.login.manage' in allowed_scopes) = 0;
