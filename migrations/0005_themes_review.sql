-- phase: expand
-- plan T2. The community-theme review columns (roadmap WS-E task 2): server/themes/routes.js added them with a
-- runtime ALTER TABLE on SQLite, so the booted schema 0001_initial.sql never carried them. The review gate (a
-- theme is visible to everyone only when review_status = 'approved') is unchanged; every existing row is
-- 'approved', the SQLite column default.

ALTER TABLE themes ADD COLUMN review_status text NOT NULL DEFAULT 'approved';
ALTER TABLE themes ADD COLUMN reviewed_by   bigint;
ALTER TABLE themes ADD COLUMN reviewed_at   text;
ALTER TABLE themes ADD COLUMN review_note   text;
