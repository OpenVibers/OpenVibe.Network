# Menu Home and Feed backend

- `GET` and `PUT /api/v1/me/home-screen` use a user Bearer token. The Network stores the validated `network.home-screen@1` value in `user_preferences.home_screen`; the account export includes `home-screen.json`, and account deletion removes the preferences row.
- `GET /api/v1/me/menu-feeds` answers `network.menu-feeds@2` `{ order, off, updated_at }`. Every offered card is on unless its id is in `off`. `PUT` accepts v2 or v1 `{ on }`; old stored `on` lists become the start of `order` on read.
- `GET /api/v1/frame/today` is public, CORS open, and cached for five minutes. It reads Report's `/api/v1/stats?days=30` and selects the latest fourteen UTC dates. `people` is Report's daily **new accounts** count. Report has no daily stream, post or new-video series yet, so those fields are `null`; a future `activity_daily` series can fill them without changing this API.

## The Feed's items

`GET /api/frame/feed` (and `/feed/search`, `/wall`) relay OpenVibe.Community's `/api/v1/feed`: Network keeps no copy,
and Community builds every card from Pulse. A card is:

```json
{
  "id": "p:2173",
  "kind": "rundown",
  "url": "https://openvibe.live/rundown/e/3005",
  "title": "WW3 Prep: The Case Against Smooth Apologies",
  "text": "Maticus warns AI companions that draft apologies and smooth conflict may outsource our emotional work…",
  "at": "2026-11-12T02:51:39.000Z",
  "site": "live",
  "site_name": "Live",
  "actor": { "name": "The Rundown", "mark": "rundown", "avatar": null },
  "subject": { "name": "Maticus", "handle": "@maticus", "avatar": "https://openvibe.media/o/med_…" },
  "image": "https://openvibe.media/f/….jpg",
  "media": { "thumb": "https://openvibe.media/f/….jpg", "ratio": 1.9047619047619047 },
  "counts": {}
}
```

- **`kind`** is the card's shape: `live` (on air now), `stream` (a go-live that is over), `clip`, `video` (a
  recording), `pic`, `post`, `meme`, `game`, `update`, `wiki`, `quest`, `chat`, `event`, `member`, `rundown` (a
  Rundown episode). A Rundown episode used to be `episode`; the new kind is the one to draw distinctly.
- **`actor`** is who or what the card is from: `{name, avatar}` for a person, or for a Rundown episode
  `{name: "The Rundown", mark: "rundown", avatar: null}`. `mark` is the glyph id the menu draws (a site id or a glyph
  id; `rundown` is The Rundown's own).
- **`subject`** (Rundown only) is the streamer the episode is about: `{name, handle, avatar}`. It is not the actor;
  the card can show both ("The Rundown" and "about @maticus").
- **`image`** (Rundown only) is the episode's own AI picture; `media.thumb` carries the same picture for the card's
  art. When no picture exists, both are the stream's thumbnail, so a card always has art. `media.ratio` is 1200/630
  for an AI picture.
- **`duration_s`** is a recording's or video's length in seconds. A recording never carries a bare `media.length`
  badge; `duration_s` is what the card formats ("1:26:43"). `media.length` is still there for clips.
- **`url`** is the thing the card opens: a Rundown episode's page (`/rundown/e/<streamId>`) or a recording's watch
  page (OpenVibe.Video), never the channel page.
