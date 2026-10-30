-- phase: expand
-- The ledger of minted run tokens (Codes C3): one row per run token, so the limit on minting counts what
-- was really minted and a run can be traced afterwards. The token itself is never stored here (only its
-- jti), and the audit row that says who minted it for whom lives in audit_log.
CREATE TABLE run_token_mints (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id text COLLATE "C" NOT NULL,
    subject text COLLATE "C" NOT NULL,
    user_id bigint,
    jti text COLLATE "C",
    minted_at bigint NOT NULL
);

CREATE INDEX idx_run_token_mints_window ON run_token_mints(client_id, subject, minted_at);
