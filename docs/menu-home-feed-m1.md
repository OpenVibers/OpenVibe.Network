# Menu Home and Feed backend

- `GET` and `PUT /api/v1/me/home-screen` use a user Bearer token. The Network stores the validated `network.home-screen@1` value in `user_preferences.home_screen`; the account export includes `home-screen.json`, and account deletion removes the preferences row.
- `GET /api/v1/me/menu-feeds` answers `network.menu-feeds@2` `{ order, off, updated_at }`. Every offered card is on unless its id is in `off`. `PUT` accepts v2 or v1 `{ on }`; old stored `on` lists become the start of `order` on read.
- `GET /api/v1/frame/today` is public, CORS open, and cached for five minutes. It reads Report's `/api/v1/stats?days=30` and selects the latest fourteen UTC dates. `people` is Report's daily **new accounts** count. Report has no daily stream, post or new-video series yet, so those fields are `null`; a future `activity_daily` series can fill them without changing this API.
