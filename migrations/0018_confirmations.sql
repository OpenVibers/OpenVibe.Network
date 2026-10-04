-- phase: expand
-- plan T2 WS-Z2. Confirmations, owner side (docs/t2-projects-and-grants.md section 3, slice 4): a sensitive use of a
-- delegated grant waits for its owner's approval (network.confirmation-request@1), and an approval may leave a standing
-- rule behind. `request_digest` binds an approval to one action; an approved row is spent once (`used_at`). Every change
-- that takes authority away cancels the pending and approved-unused rows it affects and revokes the matching rules, in
-- its own transaction (server/developer/confirmations.js cancelFor). summary and details may hold message text: they
-- never reach an audit row.

CREATE TABLE IF NOT EXISTS dev_standing_rules (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id       text COLLATE "C" NOT NULL REFERENCES dev_agents(id),
    capability     text COLLATE "C" NOT NULL,
    rule           text COLLATE "C" NOT NULL CHECK (rule IN ('session', 'until', 'always')),
    session_id     text COLLATE "C" CHECK (session_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
    until_at       text COLLATE "C",
    source         text COLLATE "C" NOT NULL CHECK (source ~ '^cnf_[0-9A-HJKMNP-TV-Z]{26}$'),
    created_at     text COLLATE "C" NOT NULL,
    created_by     text COLLATE "C" NOT NULL,
    revoked_at     text COLLATE "C",
    revoked_by     text COLLATE "C",
    CHECK ((rule = 'session') = (session_id IS NOT NULL)),
    CHECK ((rule = 'always') = (until_at IS NULL))
);
CREATE INDEX IF NOT EXISTS dev_standing_rules_live_idx ON dev_standing_rules (agent_id, capability) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS dev_confirmations (
    id             text COLLATE "C" PRIMARY KEY CHECK (id ~ '^cnf_[0-9A-HJKMNP-TV-Z]{26}$'),
    project_id     text COLLATE "C" NOT NULL REFERENCES dev_projects(id),
    agent_id       text COLLATE "C" NOT NULL REFERENCES dev_agents(id),
    owner_subject  text COLLATE "C" NOT NULL CHECK (owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    capability     text COLLATE "C" NOT NULL,
    audience       text COLLATE "C" NOT NULL,
    summary        text COLLATE "C" NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
    details        text COLLATE "C" NOT NULL DEFAULT '{}',
    resources      text COLLATE "C" NOT NULL DEFAULT '[]',
    state          text COLLATE "C" NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
    standing_rule  text COLLATE "C" CHECK (standing_rule IN ('once', 'session', 'until', 'always')),
    session_id     text COLLATE "C",
    request_digest text COLLATE "C" NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    rule_id        bigint REFERENCES dev_standing_rules(id),
    expires_at     text COLLATE "C" NOT NULL,
    created_at     text COLLATE "C" NOT NULL,
    decided_at     text COLLATE "C",
    decided_by     text COLLATE "C",
    used_at        text COLLATE "C",
    cancel_reason  text COLLATE "C",
    CHECK (state <> 'pending' OR decided_at IS NULL),
    CHECK (state NOT IN ('approved', 'denied') OR decided_at IS NOT NULL),
    CHECK (used_at IS NULL OR state = 'approved')
);
CREATE INDEX IF NOT EXISTS dev_confirmations_inbox_idx ON dev_confirmations (owner_subject, state, created_at);
CREATE INDEX IF NOT EXISTS dev_confirmations_due_idx ON dev_confirmations (expires_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS dev_confirmations_agent_idx ON dev_confirmations (agent_id, state);
CREATE INDEX IF NOT EXISTS dev_confirmations_spendable_idx ON dev_confirmations (agent_id, capability) WHERE state = 'approved' AND used_at IS NULL;
