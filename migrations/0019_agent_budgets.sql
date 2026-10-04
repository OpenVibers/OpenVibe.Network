-- phase: expand
-- plan T2 WS-Z2. Agent budgets (docs/t2-projects-and-grants.md section 3, slice 5): an owner (or an admin+) caps what
-- an agent may use of a capability it holds, never above the project's quota for it. The shape of dev_quotas, so the
-- two compare field by field. Network records budgets; the owning service meters usage against them. Revoking the
-- delegated grant deletes its budget.

CREATE TABLE IF NOT EXISTS dev_agent_budgets (
    agent_id       text COLLATE "C" NOT NULL REFERENCES dev_agents(id),
    capability     text COLLATE "C" NOT NULL,
    limit_value    bigint NOT NULL CHECK (limit_value >= 0),
    budget_window  text COLLATE "C" NOT NULL CHECK (budget_window IN ('minute', 'hour', 'day', 'month', 'total')),
    unit           text COLLATE "C" NOT NULL DEFAULT 'requests',
    updated_at     text COLLATE "C" NOT NULL,
    updated_by     text COLLATE "C" NOT NULL,
    PRIMARY KEY (agent_id, capability)
);
