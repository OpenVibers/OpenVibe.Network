# Admin clarity for the tabs outside AI and Setup

Design review notes for the owner-facing admin panel, 2026-11-07.
Plan: `plan-state-2026-10-22/OWNER-SETUP-AND-ADMIN-CLARITY-DESIGN-2026-11-07.md`, section 2
("Clarity rules for every admin page and every settings schema").

## What this change covers

Every admin tab except **AI** and the new **Setup** tab, which a separate PR rewrites:

| File | Tab |
|---|---|
| `public/js/admin/dashboard.js` | Dashboard |
| `public/js/admin/users.js` | Users |
| `public/js/admin/moderation.js` | Streams, Lineage, Bans, Chat Logs, Moderators, Moderation log, Service grants, Theme review, Operator checklist, Event deliveries |
| `public/js/admin/settings.js` | Settings (Tools, Live, Media, URLs, Discord, GitHub) |
| `public/js/admin/payments.js` | Payments, account reservation keys |
| `public/js/admin/content.js` | Pastes, Storage, Notifications, Email |
| `public/js/admin/deploy.js` | Domains, Deploy, SSH |
| `public/js/admin/analytics.js` | Analytics |

The static sections of `public/admin.html` (Broadcast, Audit, Grants, Event deliveries, Analytics cards,
Deploy panels) carry the same wording.

## The rules applied

1. **Every section starts with two sentences** — what this is, and when you would change it.
   Cards, fieldsets and panels each got an `.admin-intro` paragraph.
2. **Every field has a plain title and a help line** — what it does, what the default is, and an example.
   The machine key (`notification_max_age_days`) is still there, small and grey, after the title
   (`.admin-machine-key`), never instead of it. `ADMIN_SETTING_COPY` in `settings.js` holds the copy for the
   published settings; `adminSettingLabel()` renders it, and falls back to the service's own description plus
   the published default when a key is not listed.
3. **Every option of a choice has words** — role, delivery state, grant state, account role, domain role,
   certificate mode, web server mode and the payment switches are written as sentences, with the code kept
   only where it is the value that gets sent.
4. **Every number has its unit and what more or less means** — the help lines name the unit (minutes, days,
   kilobits per second, percent, US dollars, characters) and say which way the number moves the feature.
5. **Status is a sentence** — "The bot is not connected. Check its token and reconnect.", "Access was removed.",
   "The provider accepted the email." Raw codes stay only in grey text and tooltips.
6. **Raw JSON is advanced** — the long-text and JSON fields of the Live settings sit under an
   "Advanced settings" fold with a counted label; the fold opens itself when a value fails to save.
7. **Danger and money controls say what happens and how to undo it** — every confirmation now states the
   effect and the way back ("generate a new key", "save the previous value", "restore the backup on the server").
8. **Empty states say what to do next** — "No accounts match. Clear the search or try a different username
   or email."
9. **The glossary** is added by the Setup/AI PR. None of the six glossary words (Credits, BYOK, resale, cache,
   quota, workflow) appear in these tabs, so there is nothing to link here yet.

## The Discord block

Bot token, server ID, both channel IDs and the OAuth2 client id and secret each carry a **Where to get it**
line: the Discord Developer Portal page, the path inside it (Bot → Reset Token, OAuth2 → General), and what to
copy. The server and channel ID lines also explain that Developer Mode has to be on first, and link Discord's
own ID guide. The token and the client secret stay write-only in the server environment, as before.

## Phone

* Every control is at least 44 px tall and 44 px wide: inputs, selects, textareas, buttons, checkboxes and
  `summary` folds.
* Nothing is wider than 390 px: the tables that cannot fit become one card per row, grids collapse to one
  column, and long values wrap.
* The new rules are scoped to `.admin-clarity`, which is on the sections in scope, so the AI tab keeps its own
  styles. The shared tab bar is 44 px for every tab, which is a nav improvement rather than a change to the
  AI tab's own wording.

## Proof

`scripts/admin-clarity-proof.cjs` drives a local Network with synthetic API responses and captures each tab at
390 px and 1280 px in dark and light, then audits the page for overflow and for controls under 44 px.

```
node --import ./test/helpers/pg-preload.mjs server/index.js   # local Network on :4897
node scripts/admin-clarity-proof.cjs before    # the same pages with the previous wording and styles
node scripts/admin-clarity-proof.cjs after     # the pages as they are now
ADMIN_PROOF_CHECKS=1 node scripts/admin-clarity-proof.cjs after   # the write contract
```

Results in `work/shots/admin-clarity`:

| | before | after |
|---|---|---|
| Views captured | 92 | 92 |
| 390 px views wider than the screen | 8 | 0 |
| Controls under 44 px | 696 | 0 |
| Page errors | 0 | 0 |

The write contract check submits the same six requests with the same bodies before and after
(`after-requests.json` equals `before-requests.json`), and an invalid JSON value is refused and its field
revealed rather than left inside a closed fold.

## What was left alone

Every behaviour, permission and API call. The panels still call the same endpoints, the same payloads are sent,
the same ids and values are read from the same places, and the fields the owner cannot see (environment-held
secrets) are still disabled and empty.
