-- phase: expand
-- Group conversations (plan §AD.19; the owner, 11-17: "use .actor and .codes in a group conversation mode … multi user
-- and multi agent like you can have different actors using different harnesses and also other openvibe users per chat").
-- A group is a thread of people and agents (server/frame/groups.js). An agent is a role in the group: Actor or Codes with
-- an engine or harness; its turns run on the account of the person whose message started the round, never on anyone
-- else's, so each agent keeps one run per person (frame_group_runs).
CREATE TABLE IF NOT EXISTS frame_groups (
    id text COLLATE "C" PRIMARY KEY,
    title text NOT NULL,
    created_by text COLLATE "C" NOT NULL,
    policy jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at text NOT NULL,
    updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS frame_group_members (
    group_id text COLLATE "C" NOT NULL REFERENCES frame_groups(id) ON DELETE CASCADE,
    member_id text COLLATE "C" NOT NULL,
    kind text NOT NULL CHECK (kind IN ('person', 'agent')),
    name text NOT NULL,
    handle text COLLATE "C" NOT NULL,
    subject text COLLATE "C",
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    added_by text COLLATE "C",
    added_at text NOT NULL,
    PRIMARY KEY (group_id, member_id)
);
CREATE INDEX IF NOT EXISTS frame_group_members_subject ON frame_group_members (subject) WHERE subject IS NOT NULL;
CREATE TABLE IF NOT EXISTS frame_group_messages (
    group_id text COLLATE "C" NOT NULL REFERENCES frame_groups(id) ON DELETE CASCADE,
    seq bigint NOT NULL,
    from_id text COLLATE "C" NOT NULL,
    from_kind text NOT NULL CHECK (from_kind IN ('person', 'agent')),
    by_subject text COLLATE "C",
    text text NOT NULL DEFAULT '',
    files jsonb NOT NULL DEFAULT '[]'::jsonb,
    state text NOT NULL DEFAULT 'done',
    why text,
    run_ref text,
    usd numeric,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    PRIMARY KEY (group_id, seq)
);
CREATE TABLE IF NOT EXISTS frame_group_runs (
    group_id text COLLATE "C" NOT NULL REFERENCES frame_groups(id) ON DELETE CASCADE,
    member_id text COLLATE "C" NOT NULL,
    subject text COLLATE "C" NOT NULL,
    run_ref text NOT NULL,
    seen_seq bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, member_id, subject)
);
