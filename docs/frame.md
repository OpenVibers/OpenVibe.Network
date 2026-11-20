# The composer's Frame: models, answers, commands and mentions

Every OpenVibe site's composer reaches models, search and the person's own work through OpenVibe.Network's Frame. A
site never holds another site's keys: it sends the person's own Network token, and Network forwards it. Every route
below answers `Access-Control-Allow-Origin` only for OpenVibe's own origins, like `/api/frame/query`.

## `GET /api/frame/choices?task=chat|agent|code|image|research`

The Model sheet. Signed in, OpenVibe.AI's task choices are asked for the person (their token goes along) and every
OpenVibe row is joined with OpenVibe.Exchange's directory: its maker, its price per million tokens in and out, its
measured speed, its rating where Report has one, and its page on Exchange. Signed out, only the OpenVibe group is
named. Signed in, the groups are `openvibe`, `keys`, `machines` and `plans`; `plans` is empty with a note until
OpenVibe.Codes exposes a person's own signed-in harnesses.

```json
{
  "task": "chat",
  "recommended": { "model": "anthropic/claude-opus-5-5", "source": "openvibe" },
  "choice": { "model": "anthropic/claude-opus-5-5", "source": "openvibe" },
  "adult": false,
  "groups": [{
    "id": "openvibe", "title": "OpenVibe",
    "rows": [{
      "model": "anthropic/claude-opus-5-5", "source": "openvibe", "name": "Claude Opus 5.5", "maker": "Anthropic",
      "price": { "in": 4, "out": 20, "unit": "USD per 1M tokens" }, "free": false,
      "speed": 850, "score": 0.91, "url": "https://openvibe.exchange/models/anthropic%2Fclaude-opus-5-5"
    }]
  }]
}
```

A person's answer is `Cache-Control: private, no-store`; a signed-out one is `public, max-age=60`. A model marked
`adult` is only returned (and only accepted by Ask) when the person's account has the 18+ setting.

## `POST /api/frame/ask`

One question, answered on the chosen model with the Search Fabric's results for the chosen scopes in the prompt.
Signed in only: the person's own token pays OpenVibe.AI (their free allowance, Balance, own key or computer).

```http
POST /api/frame/ask
Authorization: Bearer <person token>
Content-Type: application/json

{
  "text": "What changed in the search fabric this week?",
  "model": "anthropic/claude-opus-5-5",
  "sources": ["web", "openvibe", "mine", "page"],
  "depth": "balanced",
  "context": { "site": "openvibe.community", "url": "https://openvibe.community/p/1", "title": "A post", "kind": "post", "id": "1" }
}
```

`model` may be a row's id or the row's `{ model, source, machine? }`; omitted, the task's recommended choice is used.
`sources` is any of `web` (Search's web scope: OpenVibe's index, DeepSeek, Wikipedia), `openvibe` (the network scope),
`mine` (your own things) and `page` (the site passes `context`, and optionally its `text`). `depth` is `quick`,
`balanced` or `deep`; Deep asks Search's deep ladder for every step's results and gives the answer more room.
`refs` are typed references and `files` are Media ids (at most 10); both go to the model.

The answer is `202 { "run": "run_…" }`. Follow it:

```http
GET /api/v1/runs/run_…/events
Authorization: Bearer <person token>
Accept: text/event-stream
Last-Event-ID: 12
```

Events are AG-UI: `RUN_STARTED`, `STEP_STARTED`/`STEP_FINISHED` (`Search`, `Read`, `Answer`),
`TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT` (`{ delta }`) for every piece of the answer, `TEXT_MESSAGE_END`, then

```json
{ "type": "ANSWER", "answer": "…[1]…", "citations": [{ "n": 1, "title": "…", "url": "https://…", "site": "…" }],
  "model": "anthropic/claude-opus-5-5", "cost_usd": 0.004 }
```

and `RUN_FINISHED` with the same answer and citations. A failure is `RUN_ERROR` with `{ code, message }`. The run is
kept in memory for five minutes after it ends, so a reconnect can resume; `GET /api/v1/runs/:id` is its snapshot.
Asks are rate-limited per person (12 a minute).

## `POST /api/frame/ask/guest` (signed out)

A visitor who is not signed in may ask the menu's box a short question (2026-11-20; the plan's §V.1 guests). The answer
is OpenVibe.AI's `network.guest_answer`, run with Network's own service token: the cheapest interactive model, at most
450 tokens, no tools, no search, no files; the same question on the same page is answered once an hour to everyone.

```http
GET  /api/frame/ask/guest/challenge   → { algorithm: "SHA-256", salt, challenge, maxnumber, signature }
POST /api/frame/ask/guest             { text, context?, site?, guest?, proof: { ...challenge, number } }
                                      → 200 { answer, model, left }
```

- **The human check:** the browser finds the `number` (0 to `maxnumber`) whose SHA-256 of `salt + number` is the
  `challenge` (ALTCHA's scheme; a second or two). A challenge is signed by Network, lives five minutes and answers one
  question: `403 guest.check_failed` otherwise.
- **Limits:** three questions a day per guest (`guest`, an id the browser keeps) and ten per address: `429
  guest.limit` ("Sign in (free) to ask up to 100 a day"). A daily budget across all guests (`NETWORK_GUEST_AI_DAILY_ASKS`,
  3000; `NETWORK_GUEST_AI_DAILY_USD`, $5): `503 guest.ai_paused` ("resting today"). An answer that failed does
  not count.
- Counted by day in `guest_asks` under keyed hashes; no address or id is kept in the clear. The run is attributed to
  `network:guest:<hash>` on OpenVibe.AI.

## `GET /api/frame/commands?site=<host>&q=`

The `/` menu. Every site offers the network's four commands, a site adds its own from its Frame manifest
(`site.commands`), and a signed-in person's saved composer snippets come last as theirs. The site's own come first,
because they are the ones that fit the box; a name appears once, so a site may replace a network command with its own.
`q` filters by the command's name (prefix) or its hint. Each row is `{ name, hint, insert, kind, needs_sign_in }`;
`name` is the word after the slash, `insert` is what a pick puts in the box, `kind` is `network`, `site` or `mine`,
and `needs_sign_in` says the command acts for a person (the composer may offer it and then sign in).

```json
{
  "site": { "id": "live", "name": "Live", "host": "openvibe.live" },
  "commands": [
    { "name": "clip", "hint": "Make a clip of the stream", "insert": "/clip ", "kind": "site", "needs_sign_in": true },
    { "name": "ask", "hint": "Ask Vibe: an answer with its sources", "insert": "/ask ", "kind": "network", "needs_sign_in": true },
    { "name": "do", "hint": "Hand it to your agent: Actor plans and runs it", "insert": "/do ", "kind": "network", "needs_sign_in": true },
    { "name": "remind", "hint": "Have Today remind you", "insert": "/remind ", "kind": "network", "needs_sign_in": true },
    { "name": "timer", "hint": "Start a focus timer in the Dock", "insert": "/timer ", "kind": "network", "needs_sign_in": true },
    { "name": "sig", "hint": "Signature", "insert": "— Sam", "kind": "mine", "needs_sign_in": false }
  ]
}
```

`site` may be a hostname, a URL or a site id (`live`); an unknown site answers `site: null` with the network four. A
signed-out answer is `Cache-Control: public, max-age=60` and held a minute; a signed-in one (the snippets need the
person) is `private, no-store` and asked fresh.

## `GET /api/frame/mentions?q=&site=`

The `@` menu: public people, the person's own agents from Network's agent directory, and OpenVibe places (open sites
and Live's public channels). At most eight rows, people first, then the person's agents, then places. Signed out it is
public people only. A person row carries the canonical subject id, the public handle, the display name and, only when
the picture is on OpenVibe.Media, the avatar; never an email, a numeric account id, a role or any other account field.
`site` is the host the box is on: that site is not suggested back to itself.

```json
{
  "mentions": [
    { "kind": "person", "id": "usr_…", "label": "Ana Followed", "handle": "ana",
      "avatar": "https://openvibe.media/p/ana/screenshot", "url": "https://openvibe.network/@ana" },
    { "kind": "agent", "id": "agt_…", "label": "Actor", "sub": "actor · online" },
    { "kind": "site", "id": "live", "label": "Live", "handle": "live", "url": "https://openvibe.live/" },
    { "kind": "channel", "id": "streamer", "label": "Streamer One", "handle": "streamer", "url": "https://openvibe.live/@streamer" }
  ]
}
```

A person's answer is `private, no-store`; a signed-out one is `public, max-age=60` and held a minute. The read is
rate-limited per actor in memory (120 a minute; a signed-in subject, or a hash of the address when signed out) and
answers `429` with `Retry-After` and `code: "frame.mentions_rate_limited"` past it.
