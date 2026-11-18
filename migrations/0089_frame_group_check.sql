-- phase: expand
-- The check before a room's reviewers (plan §AD.25; openvibe-sdk/agents/group 0.185.0 policy.gate). When a builder says
-- DONE, the room runs OpenVibe.Design's free page audit on the hand-over's links and posts what it found as a message from
-- `gate` (server/frame/room-check.js). The message kind widens to take it; nothing that exists changes.
ALTER TABLE frame_group_messages DROP CONSTRAINT IF EXISTS frame_group_messages_from_kind_check;
ALTER TABLE frame_group_messages ADD CONSTRAINT frame_group_messages_from_kind_check CHECK (from_kind IN ('person', 'agent', 'gate'));
