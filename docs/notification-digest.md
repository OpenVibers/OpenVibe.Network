# Notification digests: design (later release)

Roadmap WS-E task 3 asks for a digest design now and the digest itself in a later release. Network owns digests (ADR-020: Network keeps addressing, preferences, digests, read state and the store). Nothing here is built yet.

## Problem

A person who follows many channels, or watches many deals and alerts, gets one inbox item, toast, push and possibly email per event. The per-streamer window caps go-lives at one an hour and eight a day per streamer, but not per person. Email already has per-person and global daily caps (`email_user_daily_cap`, `email_daily_cap`), and those drop mail silently once reached.

## Decision (proposed)

- **A per-category choice.** `notification_preferences` gets a `delivery` column: `instant` (NULL, today's behaviour), `daily` or `weekly`. A person also gets a digest hour and a time zone, kept as a user preference module (`network.notifications`). The default is `instant` everywhere, so nothing changes for anyone who does not choose.
- **What never waits.** Categories `moderation`, `system` and `admin`, and anything `critical`, are always instant: security, bans and account notices. Go-lives may be digested, but the digest says "streamed while you were away", never "is live".
- **Items still land in the inbox.** A notification in a digested category is stored as today, so the badge, the realtime event and the inbox all see it. It is stored with `digest_pending = 1` and without its push, toast, sound or email. `create()` decides this from the preference, next to the mute and block checks.
- **One digest per person per period.** A job (`server/utils/jobs.js` style, every 15 min, off under drill mode) picks people whose digest is due. For each, it claims a row in `notification_digests (user_id, period_end, …)`, unique on `(user_id, period_end)`, in one transaction with the selection of the pending items. It then creates one `DIGEST` notification (category `system`, priority `low`), which is announced as `network.notification.created` like any other. Finally it sends one email through `EmailService` when the person has email on for any digested category.
  - The email's idempotency key is the digest id, so a restart mid-send never sends twice.
  - The claimed items are marked `digest_pending = 0` in the same transaction as the claim.
- **Content at build time.** Items are grouped by category, then service, then sender, newest first. There are at most 50, then "and N more", with a link to the inbox. Items already read or dismissed are left out, and so is anything from a person the recipient has blocked since. When nothing is left, there is no digest.
- **Caps.** The digest email counts once against `email_user_daily_cap`. The instant emails it replaces never count.

## Events

No new event type is needed. The digest is a notification, so the badge hears it through `network.notification.created` (type `DIGEST`). A later `network.notification.read` (reads across sites) would join the same `network.notification.*` pattern (ADR-005 amendment 2).

## Rollout

1. The schema: an idempotent ADD COLUMN plus the new table. The job stays behind `NOTIFICATION_DIGESTS=on`.
2. The preferences UI on my.openvibe.network, in the Notifications tab: a delivery choice per category, the hour and the time zone.
3. The Shared notification panel shows a `DIGEST` item as a collapsible group.

To roll back, turn the flag off. Pending items stay in the inbox as ordinary read or unread notifications, and nothing is lost.

## Tests to write with it

- A restart during a digest run sends one email and creates one `DIGEST`.
- A muted category, a blocked sender and a read item are left out.
- `critical` and `moderation` items are never delayed.
- The caps hold, and the digest hour falls correctly across a DST change.

## Open questions

- Whether the digest should also be a Web Push notification, or email and inbox only.
- Whether per-service digests are wanted, for example Deals weekly and Live daily, beyond the per-category choice.
