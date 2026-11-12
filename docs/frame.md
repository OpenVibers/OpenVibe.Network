# The composer's Frame: models and answers

Every OpenVibe site's composer reaches models, search and the person's own work through OpenVibe.Network's Frame. A
site never holds another site's keys: it sends the person's own Network token, and Network forwards it. Both routes
below answer `Access-Control-Allow-Origin` only for OpenVibe's own origins, like `/api/frame/query`.

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
