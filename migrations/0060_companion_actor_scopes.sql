-- phase: expand
-- Existing tokens keep their granted scopes; new consent grants personal Actor access.
UPDATE oauth_clients SET allowed_scopes = concat(allowed_scopes, ' actor.me.read')
WHERE client_id = 'companion' AND position('actor.me.read' in allowed_scopes) = 0;
UPDATE oauth_clients SET allowed_scopes = concat(allowed_scopes, ' actor.me.write')
WHERE client_id = 'companion' AND position('actor.me.write' in allowed_scopes) = 0;
