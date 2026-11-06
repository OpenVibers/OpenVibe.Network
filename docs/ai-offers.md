# Community AI offers in Network

OpenVibe.Node's `ai` plugin can offer a person's local models to the network ("Offer to the network"). Bot reports each
machine's offer, Network validates and stores it, and OpenVibe.AI reads it to place only opted-in requests.

## Why its own table

`platform.resource-offer@1` closes `detail` for `kind: node` and `kind: provider`, and a community model offer needs a
model list, hours, concurrency, a credit price and an audience. `platform_ai_offers` (migrations/0040) is that shape. It
is still a user-owned offer: `owner_subject` is required, there is no public route, and only a service holding
`network.registry.read` can read it whole.

## API

- `POST /internal/ai/offers/report` — `network.resource.report` (Bot). Body `{source, offers}`; source `bot`. Applies
  the whole set and marks this source's absent offers down (never deletes them).
- `GET /internal/ai/offers` — `network.registry.read` (AI). Returns `{offers, generated_at, count}` with the owner and
  the machine id, so AI can place and label the answer.

The offer: `offer_id` `ai:<device>`, `machine_id`, `owner`, `models`, `hours {start,end,tz}`, `concurrency` 1-8,
`price {in_per_million,out_per_million}` in credits, `audience` `everyone|followers|group` (with `group`), `ready`, and
`health {status: up|degraded|down}`. `server/registry/ai-offers.js` validates every field before a write; one bad offer
refuses the whole report, so Bot leaves an incomplete one out.

Network grants AI `network.registry.read` (the offers) and `network.follows.read` (the `followers` audience). Nothing
here moves money; the seller ledger is OpenVibe.AI's.

## Test

```sh
node test/run.js ai-offers
```

It covers validation, the report/mark-down cycle, the read guard (AI reads, services without it do not), AI never
reporting, and the grants.
