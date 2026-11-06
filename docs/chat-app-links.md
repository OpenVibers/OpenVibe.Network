# Chat-app accounts (Telegram, Discord, Slack) — A4

Network owns the account link between a chat identity and an OpenVibe subject. Chat's bots ask
Network who a chat account is; the person confirms the link while signed in here.

## The rows

- `linked_accounts` (existing): the link itself, in Chat's own namespaces —
  `chat:telegram`, `chat:discord`, and `chat:slack:<workspace>` with `service_user_id`
  `T…:U…`. A partial unique index (`service LIKE 'chat:%'`) makes one chat account one person.
- `chat_app_pending_links` (migration 0041): a `/link` token's **SHA-256 hash**, the app, the
  chat name, the expiry and who confirmed it. The token itself never touches the database.

A link is used once. A second signed-in account confirming the same chat account is refused
(`409`), and replacing a different linked account of the same service is refused too.

## Chat → Network (`/internal/chat-app-links`, `svc:chat` only)

The guard is `identity.subject.resolve`; the client id must be `chat` so the subject is
`svc:chat`, and only that service is let in.

| Call | What it does |
|---|---|
| `POST /` `{ token, app, service_user_id, service_username, expires_at }` | registers a pending link; expiry must be within 10 minutes; idempotent per token hash |
| `GET /?t=<token>` | `{ state: pending\|confirmed\|unknown, subject }` for the bot that made it |
| `GET /resolve?app=&id=` | `{ subject_id }` or `null` — the person behind a chat account, resolved fresh each message |
| `POST /unlink` `{ app, service_user_id, subject }` | removes the link and any pending token for that identity |

The token is 32 random bytes, base64url (43 characters). It is never logged.

## The person's pages and API

- `GET /chat-apps/link?t=<token>` — requires sign-in (a signed-out person is redirected to
  `/login?return=…`), shows the app and the chat name, and posts the confirmation. The POST is
  same-origin only and answers `410` for an expired or used token.
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
