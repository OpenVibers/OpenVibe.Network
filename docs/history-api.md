# Private visit history API

Every route is authenticated and scoped to the signed-in account. Responses are `no-store`; history is never public.
Anonymous accounts cannot read or record history. Titles are indexed with PostgreSQL full text search; URLs and page
contents are not search inputs. The shared browser relay sends only a page's type, title, URL, site, optional picture,
and private/mature flags. It never sends page contents.

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/history?cursor&limit&day&site&kind&q` | Newest first; filters by day/site/kind and title text. Returns `next_cursor`. |
| `POST /api/v1/history` | Record one thing with `{ type, title, url, image_url, private, mature }`. Private and mature rows are skipped. |
| `DELETE /api/v1/history/:id` | Remove one of your rows. |
| `DELETE /api/v1/history/day/:day` | Remove one UTC day. |
| `DELETE /api/v1/history/site/:site` | Remove one site's rows. |
| `DELETE /api/v1/history` | Clear your rows. |
| `PUT /api/v1/history/settings` | Set `{ keep_history, agents_allowed, keep_private, keep_mature }`; personal history is on by default, other choices are off. |
| `GET /api/v1/history/find?q=...` | Find rows by natural language terms using title full text. |
| `GET /api/v1/history/summary?period=day\|week` | A title-and-kind-only recent activity paragraph; no model call or page content. |
| `GET /api/v1/history/agents/recent` | Recent rows for the person's agent; returns `403 not_allowed` until the person opts in. |

The service retains up to one year and 20,000 rows per account, merging visits to the same URL for 60 minutes. The
account export includes the history and settings; account deletion erases the rows.
