-- phase: expand
-- plan T14 (ADR-046, the universal adaptive fabric). A person's own Node is the trust class user-owned: in the
-- platform.resource-offer@1 enum since Contracts 0.87.0, and in Network's pin since 0.90.0. Both trust CHECKs gain it, and a
-- user's own machine may now be user-owned as well as community; a project's machine is never user-owned. Widening
-- only: no column changes, no row is rewritten, and every existing row passes the new constraints.

ALTER TABLE platform_resource_offers DROP CONSTRAINT IF EXISTS platform_resource_offers_trust_check;
ALTER TABLE platform_resource_offers ADD CONSTRAINT platform_resource_offers_trust_check
    CHECK (trust IN ('first-party', 'user-owned', 'partner', 'community', 'external'));
ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_trust_check;
ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_trust_check
    CHECK (trust IN ('first-party', 'user-owned', 'partner', 'community', 'external'));
ALTER TABLE platform_node_principals DROP CONSTRAINT IF EXISTS platform_node_principals_owner;
ALTER TABLE platform_node_principals ADD CONSTRAINT platform_node_principals_owner CHECK (
       (owner_kind = 'platform' AND project_id IS NULL AND owner_subject IS NULL AND trust = 'first-party')
    OR (owner_kind = 'project' AND project_id IS NOT NULL AND owner_subject IS NULL AND trust NOT IN ('first-party', 'user-owned'))
    OR (owner_kind = 'user' AND project_id IS NULL AND owner_subject IS NOT NULL
        AND owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$' AND trust IN ('community', 'user-owned')));
