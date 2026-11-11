-- phase: expand
-- Test accounts: the production probes and the accounts older manual tests signed up. A test account is a real
-- account (it can sign in, act and be tested as itself) that must never reach a public surface: member lists, feeds,
-- leaderboards and the account counts. The column is the authority; OpenVibe.Network's /api/auth/register sets it for
-- every account whose name starts with ovprobe_ (the probe tooling's sign-up path), and this migration marks the
-- accounts that existed before the column did. Matching is on the exact names below, never a pattern, so a person
-- whose name merely looks like a test is not hidden.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_test bigint NOT NULL DEFAULT 0;

UPDATE users SET is_test = 1, updated_at = ov_now()
WHERE lower(username) IN (
    'ovprobe_renamed', 'ovprobe_revoke2', 'ovprobe_revoke3', 'ovprobe_modules', 'ovprobe_modules2',
    'ovprobe_devpath', 'ovprobe_publish', 'ovprobe_rt1', 'ovprobe_rt2', 'ovprobe_rt3', 'ovprobe_rt4', 'ovprobe_rt5',
    'ovprobe_merge_keep', 'ovprobe_merge_fold', 'ovprobe_worker_other', 'ovprobe_call',
    'testing_tester', 'testing_testing', 'testing_testers', 'Testtestuser123'
) AND is_test = 0;
