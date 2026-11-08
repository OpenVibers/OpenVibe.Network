# Companion Locker capability

`locker.login.manage` is an allowed scope for the public Companion OAuth client.
Existing refresh grants retain their original scopes; the person must sign in again
to approve this capability. Other public clients do not receive it.

`GET /api/v1/me/keys/companion` accepts the scoped Dock token through the existing
live session/family guard and returns only the caller's subject and wrapped Locker
key backups. It sets `Cache-Control: private, no-store`. Locker forwards the Bearer
to this endpoint for every `/api/v1/companion` request, then permits only owner login
reads/creates. Revocation, bans and deleted/merged accounts follow the same live
checks as the Dock. No private keys or login plaintext reach Network.

The new token still cannot read `/api/v1/me/keys/backup`, update/delete keys or use
ordinary account routes. Deploy Network before Locker and the Companion extension.
`npm test -- oauth-extension` covers issuance, scope refusal, own-subject reads,
key-write refusal and immediate revocation. No agent blind-fill permission is added.
