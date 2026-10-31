# The Dock's state

The Dock (plan 2026-10-30, K-D1) is one small floating surface on every OpenVibe site: your agent, your chats and
your activity. It is drawn on many domains and `localStorage` is per site, so the state it follows you with lives in
the Network. This note is the API reference for the two routes that read and write it.

Contracts 0.251.0: `network.dock-state@1` (the state) and `network.dock-result@1` (what the routes answer).
Implementation: `server/dock/index.js`, migration `0031_dock_states.sql`.

## The two routes

Both are the person's own: the subject comes from the caller's token and from nowhere else, so one person never
reads or writes another's state. They take the person's own session — the `ov_token` cookie on openvibe.network, a
Bearer user token anywhere else — and the CORS allow-list and the CSRF rules are exactly the ones the other
`/api/v1/me/*` routes use (the first-party origin allow-list in `server/index.js`; a foreign origin is refused
server-side). The browser extension's Dock token is the one scoped exception (`dock`; see `docs/sign-in.md`): it is
accepted only here and only with that scope, and it is never a cookie session.

| Route | Answer | Notes |
|---|---|---|
| `GET /api/v1/me/dock` | `network.dock-result@1` | `Cache-Control: private, no-store` |
| `PUT /api/v1/me/dock` | `network.dock-result@1` | a partial body, merged into the stored state |

### `GET /api/v1/me/dock`

```json
{
  "state": {
    "open": false,
    "tab": "activity",
    "pinned": false,
    "agent": null,
    "chat": null,
    "place": {
      "phone": { "corner": "bottom-right" },
      "desktop": { "corner": "bottom-right", "width": null, "height": null }
    },
    "updated_at": "2026-10-30T12:00:00Z"
  },
  "counts": { "running": 2, "waiting": 1, "unread": 4 },
  "sources_partial": false
}
```

`state` is the stored state, or the default (closed, on the activity tab, not pinned, bottom-right, the site's own
size) when the person has never opened the Dock.

`counts` is what the pill's status dot is drawn from: `running` and `waiting` come from the Action Center's
aggregator (`server/actions/index.js` `forPerson`, which keeps its answer for 10 s, so a page view never fans out
more than that), `unread` from the notification service's unread count. `sources_partial` is true when an authority
behind those counts did not answer, so the counts are lower than the truth — the page shows the dot anyway.

### `PUT /api/v1/me/dock`

The body is a **partial** state: any subset of the state's fields. The rest is left as it was.

```json
{ "open": true, "tab": "chats", "place": { "desktop": { "corner": "top-left" } } }
```

| Field | How it merges |
|---|---|
| `open`, `tab`, `pinned`, `chat` | replaced. `chat: null` closes the conversation. |
| `agent` | replaced whole; `null` means the Agent tab follows none. |
| `place` | merged per device class, so a body naming only `place.phone` leaves the desktop where it was. Inside a class, each field is replaced on its own (`{ "place": { "desktop": { "width": 500 } } }` keeps the corner and the height). |
| `updated_at` | the server's own; a value in the body is ignored. |

A body that is not a valid state is refused with `422` and the contract's problem shape
(`errors.problem@1`: `type`, `title`, `status`, `code`, `detail` and the `errors` array with the path and the
message of each fault). A key the contract does not know is refused like any other fault, not quietly dropped.

A write is limited to **60 a minute per person**; past that the answer is `429` with the code `dock.rate_limited`.
The page debounces anyway, and a runaway tab must not fill the table.

## The state

| Field | Meaning |
|---|---|
| `open` | open (a sheet on a phone, a floating card on a desktop) or collapsed to its pill |
| `tab` | `agent`, `chats` or `activity` |
| `pinned` | keep the pill on screen even when nothing runs and nothing waits |
| `agent` | `{ service: 'actor' \| 'codes' \| 'run' \| 'desks', id }` — the agent the Agent tab follows — or `null` |
| `chat` | the conversation the Chats tab has open, or `null` |
| `place.phone.corner` | `bottom-right`, `bottom-left`, `top-right` or `top-left` |
| `place.desktop` | the same `corner`, plus `width` (320..720) and `height` (360..900), each `null` for the site's own default size |
| `updated_at` | when the state was last written |

Every object refuses extra keys, so a page cannot smuggle a field into the state another page reads.

## Account data

The row is the person's own, so it goes into their account export (`network/dock.json` in Network's part of the
zip) and is erased with them (ADR-033). A merge (ADR-029) leaves it with the surviving account: the survivor's row
wins, and a folded-in row moves over only when the survivor has none.
