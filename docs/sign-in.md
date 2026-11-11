# Signing in with OpenVibe.Network

OpenVibe.Network is the one account system behind every OpenVibe site, and any app can use it. It is a standard
OAuth 2.0 / OpenID Connect provider:

| What | Where |
|---|---|
| Discovery | `https://openvibe.network/.well-known/openid-configuration` |
| Authorize | `https://openvibe.network/oauth/authorize` (code flow, PKCE S256) |
| Token | `https://openvibe.network/oauth/token` |
| User info | `https://openvibe.network/oauth/userinfo` |
| Keys | `https://openvibe.network/api/.well-known/jwks` |

A Link site gets the whole client (routes, PKCE, cookies, offline verification) from `openvibe-sdk/sso`. Third-party
apps register in the developer console ([developer-projects.md](developer-projects.md)).

## The account chooser

A browser can be signed in to several accounts at once, the way Google's sign-in works. `/oauth/authorize` sends an
interactive sign-in to the chooser (`/login`), which lists this browser's accounts, with **Use another account**,
**Create a new account** and **Forgot password**. Picking an account sends the app its code.

The chooser **does not continue by itself** on an interactive sign-in, even with one account saved. Signing out of a
site and pressing Sign in again shows the chooser. It continues without a click only:

- for the account the person chose a moment ago in the same tab (a site menu's switch or "add another account" below:
  the page remembers it for two minutes, once);
- for the account the app names with `login_hint`, when this browser has it saved.

It never continues by itself for a third-party app (the person sees its consent), when the app asks for the chooser,
or as an anonymous account.

## Parameters

| Parameter | Effect |
|---|---|
| `prompt=none` | No page: a code for the account this browser is signed in to, or `error=login_required`. Sites use it to sign people in quietly when they open a site. Refused for third-party apps (`interaction_required`). |
| `prompt=select_account` | The chooser, even when `login_hint` names a saved account. |
| `prompt=login` | The sign-in form ("use another account"). |
| `reauth=1` | A real re-authentication: the password form every time, even when this browser is already signed in, with `login_hint` prefilled and `return` as the way back. The new session's `auth_time` is now, so it satisfies the 10-minute fresh check (account deletion, the owner's AI settings, Locker reset/forget). Use this rather than `add_account=1` for those. |
| `login_hint` | The account to continue as: a username (`@` optional) or an account id. Saved in this browser: continues as it. Not saved: the sign-in form with the username filled in. |
| `nonce` | Echoed in the `id_token` (scope `openid`). |

## Asking for consent per purpose (`consent:<purpose>`)

Every AI or data use of a person is off until that person turns it on (the consent plan, L24). An app, an OpenVibe
site or a developer's app alike, asks for a purpose in the same sign-in by adding one scope per purpose beside its
own scopes, for example `scope=profile consent:ai.train consent:app.data` (Contracts 0.307.0,
`network.consent-claim@1`).

| Scope | What the screen asks |
|---|---|
| `consent:ai.train` | **Train AI on your content** (18+) |
| `consent:data.public` | **Put your content in an open dataset** (18+) |
| `consent:face.recognize` | **Recognise your face** (18+) |
| `consent:app.data` | **Use your content** |

- **Only those.** A purpose the Contracts consent family does not define (the retired `ai.looks` included) is refused:
  `/oauth/authorize` sends the app back to its `redirect_uri` with `error=invalid_scope`, and `/oauth/client-info` and
  `/oauth/confirm` answer 400 `invalid_scope`.
- **The screen.** After the person picks an account, the sign-in page lists each purpose the app asked for that the
  person has not answered yet, in plain words (`server/consent/apps.js`, wording version `2026-11-07.1`). Each one is
  its own checkbox, none ticked, and **Continue** works with none ticked. The 18+ purposes ask for "I am 18 or older"
  unless the account already confirmed it. `prompt=none` never shows the screen: it asks nothing.
- **Granted.** A ticked purpose is a `consents` row: the person, the app's client id, the purpose, when, the wording
  version and `source` `oauth`, with a `network.consent.changed` event. The person turns it off under **Apps you
  allowed** on the account page (`DELETE /api/v1/me/consent/:purpose/:client`).
- **Refused.** A purpose left unticked is kept in `consent_refusals`, and that app does not ask for it again for 30 days.
  The person can end that early with **Ask me next time** (`DELETE /api/v1/me/consent/:purpose/:client/refusal`).
- **The token.** Every token from that sign-in carries the claim `consent`: the purposes it asked for that the person
  granted to that app and that are active when the token is issued, `[]` when none. The claim is absent when no consent
  scope was asked. A refresh works it out again, so a purpose turned off is gone from the next token. The token
  response's `scope` names `consent:<purpose>` only for granted ones. An app never learns more than "not granted",
  and another app's grants never count: not on the screen, not in the claim, not in `POST /internal/consent/check`
  (which answers an app's grant only when the check names that app as `client`).

## Switching and adding accounts from a site

The shared navbar's account menu works this way on every site, whatever session the site keeps, and any site or app
can build the same links:

- **Switch:** `https://openvibe.network/login?switch_to=<account id>&login_hint=<username>&return=<the site's sign-in URL>`.
  The Network makes that account the active one (or asks for its password), then goes to `return`. The site's sign-in
  starts an ordinary authorize, and the chooser continues as the account just chosen.
- **Add another account:** `https://openvibe.network/login?add_account=1&return=<the site's sign-in URL>`: the sign-in
  form, then the same way back.

`return` must be an https origin of a first-party site (`GET /api/auth/return-origins` lists them: every domain in the
service manifests). Anything else goes to the Network's home.

## The browser extension (public client)

The OpenVibe Companion's Dock signs in as `companion`, a **public** first-party client with no secret:
authorization code + PKCE S256 only, exact redirect URIs
`https://<chrome-id>.chromiumapp.org/` and
`https://<sha1-of-addon-id>.extensions.allizom.org/`. Its access token is issued with the private
issuer `<network issuer>/dock`, the audiences `openvibe.network` and `openvibe.chat`, no `role` or
`staff_caps`, and only these scopes:

| Scope | The Dock may |
|---|---|
| `dock` | read and write the person's Dock state |
| `activity` | read the action list and notifications, mark them read, get a realtime ticket |
| `chat.read` | list and read DMs, mark a conversation read |

It may not approve an action, send a message, change the account, spend, or call another service with
that token. The refresh token lives 30 days, rotates on every use and is revoked by the extension's
Sign out, by the account page's **Signed-in apps** section (`/my`), or by signing out everywhere.

## Signing out

A site's **Sign out** ends that site's session and keeps the browser from signing back in quietly (`ov_sso_hint=guest`).
The next Sign in shows the chooser. Signing out of OpenVibe.Network itself (openvibe.network/my) removes the account
from this browser.
