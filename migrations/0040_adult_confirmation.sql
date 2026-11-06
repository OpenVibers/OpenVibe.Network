-- phase: expand
-- The Exchange remake's uncensored tier: the account's own 18+ confirmation (server/identity/adult.js). It is a
-- timestamp, never a birth date; OpenVibe.AI reads it through /internal/identity/adult and never guesses an age.
-- Null means no confirmation (the default), and withdrawing the confirmation clears it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS adult_confirmed_at text COLLATE "C";
