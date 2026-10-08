-- phase: migrate
-- The developer portal moved from OpenVibe.Codes to OpenVibe.Services (owner decision 2026-10-08; openvibe-contracts
-- 0.113.0 retired codes.release.read|manage for services.release.read|manage, audience openvibe.services). An app's
-- grant moves with it: same app, same status and history, the new capability and audience. Production held 17 approved
-- codes.release.manage grants (sandbox apps from the developer path) and no services.release.* row, so nothing
-- collides. Rollback: the reverse UPDATE (a Network release from before this one refuses the new names as unknown).
UPDATE dev_grants SET capability = 'services.release.manage', audience = 'openvibe.services'
 WHERE capability = 'codes.release.manage';
UPDATE dev_grants SET capability = 'services.release.read', audience = 'openvibe.services'
 WHERE capability = 'codes.release.read';
