-- phase: migrate
-- The feed's job and event cards open the site's own page (plan §AB.46; the owner, 11-14: "doesn't even bring you to the
-- right page"). Work's cards went to the job board a listing came from (arbeitnow, weworkremotely) and Today's holiday
-- cards to date.nager.at's JSON API; server/feed/sources.js now builds openvibe.work/jobs/<id> and openvibe.today/e/<id>,
-- and this moves the rows read before that. Idempotent.
UPDATE feed_items SET url = 'https://openvibe.work/jobs/' || source_id
 WHERE source_service = 'work' AND source_type = 'job' AND source_id ~ '^job_[A-Za-z0-9]{8,80}$'
   AND url NOT LIKE 'https://openvibe.work/%';
UPDATE feed_items SET url = 'https://openvibe.today/e/' || source_id
 WHERE source_service = 'today' AND source_type = 'event' AND source_id ~ '^[A-Za-z0-9_-]{1,80}$'
   AND url NOT LIKE 'https://openvibe.today/%';
