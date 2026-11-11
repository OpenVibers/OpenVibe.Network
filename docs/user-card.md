# Shared user card read

`GET /api/v1/people/:username/card` is a public, credential-free CORS read. The owner enables it with the existing owner-only `PUT /api/admin/settings`: `{"key":"user_card_enabled","value":"true","type":"boolean"}`. It defaults off and returns HTTP 503 `{"error":"user_card.disabled"}` until enabled. No production setting is changed by this migration.

Example (optional fields are omitted when hidden or unavailable):

```json
{"username":"Example","display_name":"Example","avatar_url":"https://openvibe.network/avatar/Example?s=160","profile_url":"https://openvibe.network/@Example","level":4,"streak":3,"badges_count":2,"followers":10,"live":{"now":true,"site":"live","url":"https://openvibe.live/@Example"},"channel_url":"https://openvibe.live/@Example","active_sites":[{"id":"live","name":"Live","url":"https://openvibe.live"}]}
```

Network owns global levels (ask 241), followers, identity and history. Quest supplies the daily completion streak in the person's chosen time zone, with yesterday's streak retained until today's end, and the badge count. Live supplies current channel state; a missing channel or failed source is absent, never an invented offline state. No presence/last-seen timestamps, page titles, visited URLs or shared relationships leave the public read. The only viewer-dependent data is `actions`, and only when the viewer sends their token (see Actions).

The aggregate has a process-local 30-second cache capped at 2,000 entries; concurrent misses share one promise. All card enrichments share this aggregate cache. Quest/Live card reads time out after two seconds, refuse redirects, and use only operator-configured service origins. Account eligibility and visibility are reread before cache use. HTTP responses use `Cache-Control: no-store` so browsers/CDNs cannot keep a hidden field alive. Unknown, banned, deleted, merged and anonymous accounts return 404; old handles temporarily redirect to the canonical read.

`GET/PUT /api/v1/me/card-visibility` reads/patches booleans for `display_name`, `avatar_url`, `live`, `level`, `streak`, `badges_count`, `followers`, `active_sites`, `channel_url`. Fields default on except `active_sites`, which requires explicit opt-in to share site names from the last seven days of history. A private profile suppresses every enrichment; hidden Live places suppress live/channel links, hidden presence suppresses live state, and leaderboard opt-out suppresses level. Paused history or retaining private/mature history suppresses weekly sites. Public-place exclusions also filter sites. These stronger choices override card preferences. Preferences are included in account export and cleared on deletion.

## Actions (ask 287)

The read gains `actions: [{ id, label, href|method, state }]`, computed per request with the
viewer's token and never cached. Send the Network session as `Authorization: Bearer …` (or the
session cookie); a missing, expired or revoked token reads as anonymous, never a 401. Without
a viewer — or on the viewer's own card — the card keeps only Profile/Channel. A viewer who
blocked the person sees Unblock + Report; a viewer the person blocked sees Block + Report.

For a signed-in viewer and another person, neither blocking the other:

```json
{"actions": [
  {"id": "message", "label": "Message", "href": "https://openvibe.chat/messages"},
  {"id": "follow", "label": "Follow", "method": "PUT", "path": "/api/v1/me/follows/channel/Example", "state": {"following": false}},
  {"id": "add-friend", "label": "Add friend", "method": "PUT", "path": "/api/v1/me/friends/Example", "state": {"friendship": "none"}},
  {"id": "tip", "label": "Tip", "href": "https://openvibe.tips/Example"},
  {"id": "watch", "label": "Watch together", "href": "https://openvibe.live/@Example"},
  {"id": "mute", "label": "Mute", "method": "PUT", "path": "/api/v1/me/mutes/Example", "state": {"muted": false}},
  {"id": "block", "label": "Block", "method": "PUT", "path": "/api/v1/me/blocks/Example", "state": {"blocked": false}},
  {"id": "report", "label": "Report", "method": "POST", "path": "/api/v1/me/reports", "body": {"target": "Example", "reason": "other", "detail": ""}, "state": {"reported": false}}
]}
```

`{ id, label, href }` opens somewhere: Message starts in the chat inbox, Tip opens the
person's tip page on OpenVibe.Tips, and `watch` opens their channel and appears only while they
are live. `{ id, label, method, path, state }` calls the Network route with the viewer's token
(a `report` also carries `body`). `state.friendship` is one of `none`, `pending` (I added them
— the action reads Cancel request), `requested` (they added me — the action reads Accept),
`friends`. Mute/Unmute and Block/Unblock carry their state the same way. The client must send
the viewer's Network token with the read for these to appear; the bare public read (a site
fetching with no token) keeps Profile/Channel only.

Staff tools follow Contracts' staff-role map, not a second role list here: a viewer holding
`staff.moderation.logs` also gets the Review queue and the User-reports queue filtered to the
person. Follow/Unfollow reuse `PUT/DELETE /api/v1/me/follows/channel/:target`; Block/Unblock
reuse `PUT/DELETE /api/v1/me/blocks/:target`. New beside them:

- `GET /api/v1/me/mutes`, `PUT/DELETE /api/v1/me/mutes/:subjectOrUsername` — hush one person's
  non-staff notices (server/identity/mutes.js). Nobody mutes themselves; guests neither mute
  nor are muted.
- `GET /api/v1/me/friends`, `PUT/DELETE /api/v1/me/friends/:subjectOrUsername` — add one
  direction at a time; friends when both are active (server/identity/friends.js).
- `POST /api/v1/me/reports { target, reason, detail }` — file about another person (reasons:
  `spam`, `harassment`, `impersonation`, `explicit`, `scam`, `other`; 201 new, 200 while one is
  still open). Staff holding `staff.moderation.logs` read `GET /api/v1/staff/user-reports`
  (`?status=open&target=usr_…&limit=`).

Mute, friend and report changes carry no relayed event yet: nothing consumes them, so the
revision only orders the card's state. A service that should honour a mute reads the same
subject pairs the way it reads blocks; that internal read (with its own Contracts capability)
is a follow-up.

## Next for the design (For Fable)

Build the common card appearance and the account controls for field visibility (including explicit weekly-site sharing), using this read and the Shared hook. No new page styling ships here. Render the `actions` array (kit buttons: `ovk-btn ovk-btn--primary|quiet`); a `method` action calls its Network route with the viewer's token. Site-specific rows (Live: mod actions; Quest: rank) remain follow-up work outside this read.
