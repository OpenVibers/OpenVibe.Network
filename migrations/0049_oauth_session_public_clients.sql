-- phase: expand
-- A public first-party app that signs the person in for real (OpenVibe Link on the phone, plan 2026-11-07 §13.2).
-- Until now every public client's token was the extension's read-only Dock token: a private issuer, its own audiences
-- and no role, so no service's normal user-token check would take it. An app that answers approvals and uploads files
-- needs the person's own session; its proof is PKCE, not a secret an APK cannot keep. 0 keeps every client as it is.
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS session_token bigint DEFAULT 0;
