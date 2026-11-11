-- phase: expand
-- 0075 matched the existing test accounts with `lower(username) IN (...)`, but one name was written in its mixed case
-- (`Testtestuser123`), so the comparison never met it and the account stayed public. Mark it now, by its exact name
-- compared in lower case like the rest of the list. A separate file because migrations are never edited after they run.
UPDATE users SET is_test = 1, updated_at = ov_now()
WHERE lower(username) = 'testtestuser123' AND COALESCE(is_test, 0) = 0;
