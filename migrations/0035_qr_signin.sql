-- phase: expand
-- Sign in on your phone (owner, 2026-11-04): a desktop shows a QR code, a phone scans it, the desktop
-- confirms the two-digit code the phone shows, and the phone gets an ordinary Network session.
--
-- The secret is never stored, only its SHA-256; the match code and the phone's ov_qr nonce are hashed
-- the same way. expires_at is an ISO-8601 UTC string so comparisons stay lexical on PostgreSQL and
-- PGlite. Rows are swept once expired (server/auth/qr-signin.js sweep, server/index.js timer); the
-- audit_log rows remain.
CREATE TABLE qr_signin_transfers (
    id text COLLATE "C" PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_hash text COLLATE "C" NOT NULL,
    creator_jti text COLLATE "C" NOT NULL,
    status text COLLATE "C" NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'scanned', 'approved', 'denied', 'used')),
    code_hash text COLLATE "C",
    attempts integer NOT NULL DEFAULT 0,
    phone_nonce_hash text COLLATE "C" UNIQUE,
    device_summary text COLLATE "C",
    scanned_at text COLLATE "C",
    approved_at text COLLATE "C",
    used_at text COLLATE "C",
    expires_at text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);
CREATE INDEX qr_signin_transfers_user_live ON qr_signin_transfers (user_id, status, expires_at);
CREATE INDEX qr_signin_transfers_expiry ON qr_signin_transfers (expires_at);

-- The 10-starts-per-person-per-hour budget, counted across processes. Rows live two hours and are
-- swept with the transfers; audit_log separately records each start.
CREATE TABLE qr_signin_starts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);
CREATE INDEX qr_signin_starts_user_time ON qr_signin_starts (user_id, created_at);
