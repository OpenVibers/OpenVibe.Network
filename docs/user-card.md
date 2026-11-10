# Shared user card read

`GET /api/v1/people/:username/card` is a public, credential-free CORS read. The owner enables it with the existing owner-only `PUT /api/admin/settings`: `{"key":"user_card_enabled","value":"true","type":"boolean"}`. It defaults off and returns HTTP 503 `{"error":"user_card.disabled"}` until enabled. No production setting is changed by this migration.

Example (optional fields are omitted when hidden or unavailable):

```json
{"username":"Example","display_name":"Example","avatar_url":"https://openvibe.network/avatar/Example?s=160","profile_url":"https://openvibe.network/@Example","level":4,"streak":3,"badges_count":2,"followers":10,"live":{"now":true,"site":"live","url":"https://openvibe.live/@Example"},"channel_url":"https://openvibe.live/@Example","active_sites":[{"id":"live","name":"Live","url":"https://openvibe.live"}]}
```

Network owns global levels (ask 241), followers, identity and history. Quest supplies the daily completion streak in the person's chosen time zone, with yesterday's streak retained until today's end, and the badge count. Live supplies current channel state; a missing channel or failed source is absent, never an invented offline state. No presence/last-seen timestamps, page titles, visited URLs, shared relationships or viewer-dependent data leave this public read.

The aggregate has a process-local 30-second cache capped at 2,000 entries; concurrent misses share one promise. Existing Quest badges retain their 60-second source cache. Quest/Live card reads time out after two seconds, refuse redirects, and use only operator-configured service origins. Account eligibility and visibility are reread before cache use. HTTP responses use `Cache-Control: no-store` so browsers/CDNs cannot keep a hidden field alive. Unknown, banned, deleted, merged and anonymous accounts return 404; old handles temporarily redirect to the canonical read.

`GET/PUT /api/v1/me/card-visibility` reads/patches booleans for `display_name`, `avatar_url`, `live`, `level`, `streak`, `badges_count`, `followers`, `active_sites`, `channel_url`. Fields default on except `active_sites`, which requires explicit opt-in to share site names from the last seven days of history. A private profile suppresses every enrichment; hidden Live places suppress live/channel links, hidden presence suppresses live state, and leaderboard opt-out suppresses level. Paused history or retaining private/mature history suppresses weekly sites. Public-place exclusions also filter sites. These stronger choices override card preferences. Preferences are included in account export and cleared on deletion.

## Next for the design (For Fable)

Build the common card appearance and the account controls for field visibility (including explicit weekly-site sharing), using this read and the Shared hook. No new page styling ships here. Relationship actions and site-specific rows remain follow-up work outside this read.
