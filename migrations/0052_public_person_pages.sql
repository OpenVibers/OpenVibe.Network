-- phase: expand
-- Public person pages on openvibe.my. These settings belong to the account, not a client app.
ALTER TABLE users ADD COLUMN IF NOT EXISTS public_page_bio text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS public_page_links jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS public_page_places jsonb NOT NULL DEFAULT '{"live":true,"media":true,"space":true,"community":true}'::jsonb;
