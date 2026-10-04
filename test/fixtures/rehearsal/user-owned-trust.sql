-- Rehearsal seed for migrations/0020_user_owned_trust.sql (docs/cutover-t14-user-owned-trust.md): rows as production may
-- hold them at 0019, one node principal per owner kind and one offer per trust class 0007 allowed, so the widened
-- CHECKs are validated against existing rows. Fixed ids, repeatable, PostgreSQL only; no secret (a fake 64-hex hash).
INSERT INTO dev_projects (id, owner_subject, name, created_at, created_by)
    VALUES ('prj_0000000000000000000000RH01', 'usr_0000000000000000000000RH01', 'Rehearsal lab', '2026-10-01T00:00:00Z', 'rehearsal') ON CONFLICT DO NOTHING;
INSERT INTO platform_node_principals (id, node_id, home_cell, owner_kind, project_id, owner_subject, trust, created_by, credential_hash) VALUES
    ('nod_0000000000000000000000RH01', 'rh-platform', 'wnam-1', 'platform', NULL, NULL, 'first-party', 'rehearsal', NULL),
    ('nod_0000000000000000000000RH02', 'rh-project', 'wnam-1', 'project', 'prj_0000000000000000000000RH01', NULL, 'partner', 'rehearsal', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    ('nod_0000000000000000000000RH03', 'rh-user', 'wnam-1', 'user', NULL, 'usr_0000000000000000000000RH01', 'community', 'rehearsal', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')
    ON CONFLICT DO NOTHING;
INSERT INTO platform_resource_offers (id, source, kind, region, cell, trust, status, price_usd, doc, reported_at) VALUES
    ('rh-platform', 'rehearsal', 'node', 'us-west', 'wnam-1', 'first-party', 'up', 0, '{"offer_id":"rh-platform"}', '2026-10-01T00:00:00Z'),
    ('rh-project', 'rehearsal', 'node', 'us-west', 'wnam-1', 'partner', 'up', 0, '{"offer_id":"rh-project"}', '2026-10-01T00:00:00Z'),
    ('rh-user', 'rehearsal', 'node', 'us-west', 'wnam-1', 'community', 'degraded', 0, '{"offer_id":"rh-user"}', '2026-10-01T00:00:00Z'),
    ('rh-provider', 'rehearsal', 'provider', 'us-west', 'wnam-1', 'external', 'up', 0.01, '{"offer_id":"rh-provider"}', '2026-10-01T00:00:00Z')
    ON CONFLICT DO NOTHING;
