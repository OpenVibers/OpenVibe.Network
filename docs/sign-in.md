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

A Node site gets the whole client (routes, PKCE, cookies, offline verification) from `openvibe-sdk/sso`. Third-party
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
| `login_hint` | The account to continue as: a username (`@` optional) or an account id. Saved in this browser: continues as it. Not saved: the sign-in form with the username filled in. |
| `nonce` | Echoed in the `id_token` (scope `openid`). |

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

## Signing out

A site's **Sign out** ends that site's session and keeps the browser from signing back in quietly (`ov_sso_hint=guest`).
The next Sign in shows the chooser. Signing out of OpenVibe.Network itself (openvibe.network/my) removes the account
from this browser.
