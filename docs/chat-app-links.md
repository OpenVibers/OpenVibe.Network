# Chat-app accounts (Telegram, Discord, Slack) — A4

Network owns the account link between a chat identity and an OpenVibe subject. Chat's bots ask
Network who a chat account is; the person confirms the link while signed in here. Linking is
**two-way**: a forwarded confirm URL alone links nothing.

## The flow

1. The person sends `/link` to the bot from their own chat. Chat registers a pending link (a
   43-character token, stored as a SHA-256 hash) and sends them the confirm URL.
2. While signed in on Network, the person confirms. Nothing is linked yet: the page says plainly
   that this chat account will talk to their agent and approve its steps, and shows a **6-digit
   code** (10 minutes, kept only as a hash bound to that chat identity).
3. The person sends that code to the bot **from the same chat account** that started `/link`.
   Chat calls `finish` with its own identity and the code; only then is the `linked_accounts` row
   written. A different chat account cannot finish it, three wrong codes cancel it, and an
   expired code cannot be used.

## The rows

- `linked_accounts` (existing): the link itself, in Chat's own namespaces —
  `chat:telegram`, `chat:discord`, and `chat:slack:<workspace>` with `service_user_id`
  `T…:U…`. A partial unique index (`service LIKE 'chat:%'`) makes one chat account one person.
- `chat_app_pending_links` (migration **0042**): the token's **SHA-256 hash**, the app, the chat
  name, the bot handle the page names, the expiry, who confirmed it (`confirmed_by`, on Network),
  the **code hash**, when the code expires, the wrong-code attempts, and the finished/cancelled
  marks. Neither the token nor the code is ever stored in the clear.

One chat account is one person; a second signed-in account confirming the same chat account is
refused (`409`), and replacing a different linked account of the same service is refused too.

## Chat → Network (`/internal/chat-app-links`, `svc:chat` only)

The guard is `identity.subject.resolve`; the client id must be `chat` so the subject is
`svc:chat`, and only that service is let in.

| Call | What it does |
|---|---|
| `POST /` `{ token, app, service_user_id, service_username, bot_handle, expires_at }` | registers a pending link; expiry must be within 10 minutes; idempotent per token hash |
| `GET /?t=<token>` | `{ state: pending\|confirmed\|finished\|cancelled\|unknown, subject }` |
| `POST /finish` `{ app, service_user_id, code }` | the same chat account sends the code: `{ ok: true, subject }`, or `{ ok: false, error: code\|expired\|no_link, attemptsLeft }`; `404` when this chat account started nothing |
| `GET /resolve?app=&id=` | `{ subject_id }` or `null` — the person behind a chat account, resolved fresh each message (only a finished link appears) |
| `POST /unlink` `{ app, service_user_id, subject }` | removes the link and any pending token for that identity |

The token is 32 random bytes, base64url (43 characters); the code is six digits from
`crypto.randomInt`. Neither is ever logged.

## The person's pages and API

- `GET /chat-apps/link?t=<token>` — requires sign-in (a signed-out person is redirected to
  `/login?return=…`), says what linking does, and shows the confirm button. Answers `410` for an
  expired, cancelled or finished token.
- `POST /chat-apps/link` — same-origin only; confirms and returns the code page: the 6 digits,
  the bot (`@<bot_handle>`), the chat account to send them from, and that the code is shown once.
  Confirming again rotates the code.
- `GET /api/v1/me/chat-apps` — the signed-in person's links: `app`, `workspace` (Slack only),
  `service_user_id`, `service_username`, `linked_at`. No token or hash is returned.
- `DELETE /api/v1/me/chat-apps/:app` — removes the person's own link (`telegram`, `discord` or
  all Slack workspaces for `slack`); `404` when there is none.

## Configuration

- The `chat` OAuth client on Network holds `identity.subject.resolve` on `openvibe.network`
  (`server/identity/principals.js`, the grant list). It already held `actor.agent.manage` and
  `actor.task.create/read` for Actor.
- Chat's `/etc/openvibe/chat.env` needs `OV_OAUTH_CLIENT_ID=chat` and the client secret, and
  `CHAT_LINK_CONFIRM_URL` must point at `https://openvibe.network/chat-apps/link`.
- nginx for `openvibe.network` already sends `/chat-apps` and `/api/` to Network; nothing new.

## Account data

`network.account.deleted` removes the person's pending chat-app links; their `linked_accounts`
rows go with the existing erase. Chat removes its own link tokens, buttons and queued deliveries
(see Chat's `docs/chat-apps.md`).
