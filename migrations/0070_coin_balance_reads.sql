-- phase: expand
-- Ask 273: the person's own read state for OpenCoins "what changed since I last looked".
-- One row per person: the coin_transactions id cursor the bar has already shown.
CREATE TABLE IF NOT EXISTS coin_balance_reads (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    currency text NOT NULL CHECK (currency IN ('opencoins')),
    last_seen_tx bigint NOT NULL REFERENCES coin_transactions(id),
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now(),
    PRIMARY KEY (user_id, currency)
);
