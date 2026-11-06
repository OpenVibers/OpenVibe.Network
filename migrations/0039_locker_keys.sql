-- phase: expand
-- The Locker key directory (design 2026-11-06, LOCKER-DESIGN-2026-11-06.md, section 4 "Network: the key directory").
--
-- A person's locker is two P-256 key pairs (an ECDH one that receives content keys, an ECDSA one that signs the
-- fingerprint) and a copy of the private halves wrapped by a key from their locker passphrase. Network stores the
-- public halves, the self-signature and the wrapped copies as opaque bytes: it can read the public keys and the
-- fingerprint, and it can never read a private key.
--
-- Three tables:
--   locker_keys        one row per person: the public keys, the fingerprint and the self-signature.
--   locker_key_backups one row per person and kind (passphrase, recovery, passkey): the wrapped private keys,
--                       stored exactly as the browser sealed them. Network checks the shape and never opens it.
--   locker_key_history every key change, append-only: what the fingerprint was and what it became, so a share
--                       sheet can warn when a key changed since the people saw it. The reason says why: the keys
--                       were created, rotated (new keys), restored (the same keys, new backups), reset (the
--                       passphrase and the recovery kit were both lost) or forgotten.
--
-- Expand only: an older release never reads these tables, and nothing here changes an existing one.
CREATE TABLE IF NOT EXISTS locker_keys (
    subject text COLLATE "C" PRIMARY KEY,
    ecdh_public jsonb NOT NULL,
    signing_public jsonb NOT NULL,
    fingerprint text COLLATE "C" NOT NULL,
    self_signature text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso()
);

CREATE TABLE IF NOT EXISTS locker_key_backups (
    subject text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('passphrase', 'recovery', 'passkey')),
    blob jsonb NOT NULL,
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso(),
    PRIMARY KEY (subject, kind)
);

CREATE TABLE IF NOT EXISTS locker_key_history (
    id bigserial PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    fingerprint text COLLATE "C" NOT NULL,
    "from" text COLLATE "C",
    "to" text COLLATE "C",
    reason text COLLATE "C" NOT NULL CHECK (reason IN ('created', 'rotated', 'restored', 'reset', 'forgotten')),
    changed_at text COLLATE "C" NOT NULL DEFAULT ov_now_iso()
);
CREATE INDEX IF NOT EXISTS locker_key_history_subject ON locker_key_history (subject, id);

-- Append-only: nothing updates or deletes a history row, ever. The history is the proof of what a key was.
CREATE OR REPLACE FUNCTION locker_key_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'locker_key_history is append-only';
END $$;
DROP TRIGGER IF EXISTS locker_key_history_no_change ON locker_key_history;
CREATE TRIGGER locker_key_history_no_change BEFORE UPDATE OR DELETE ON locker_key_history
    FOR EACH ROW EXECUTE FUNCTION locker_key_history_append_only();
