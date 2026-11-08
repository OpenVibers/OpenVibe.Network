# Trust signals

OpenVibe.Network exposes coarse account and guest signals for abuse prevention. Read a person's own signals with their
own account token, or a guest's own signals with that guest session token:

```sh
curl -H "Authorization: Bearer $TOKEN" https://openvibe.network/api/v1/me/trust
```

A service can read a subject's signals with a service token that has `identity.trust.read`:

```sh
curl -H "Authorization: Bearer $SERVICE_TOKEN" \
  https://openvibe.network/api/v1/trust/usr_01JAB2C3D4E5F6G7H8J9K0MNP1
```

Use `gst_…` in place of `usr_…` for a guest. Responses are rate limited and carry `Cache-Control: private, no-store`.
The same result is available to a signed-in person in OpenVibe Connect MCP as `network.my_trust.read`.

Accounts have `kind: "account"`, the existing `account_age_hours` and `account_age_days`, and an `age_band`:

```json
{
  "kind": "account",
  "age_band": "30d_plus",
  "account_age_hours": 960,
  "account_age_days": 40,
  "passkey": true,
  "linked_accounts": 2,
  "active_30d": true,
  "email_verified": true,
  "verified": true,
  "verified_by": ["passkey", "linked_account", "30_days_active"]
}
```

Guests have age, network counts, a count of other guests first seen from any of their networks in the past 24 hours, and
whether the guest became an account. `sessions` is omitted unless the server tracks distinct session days.

```json
{
  "kind": "guest",
  "age_band": "under_1d",
  "age_hours": 3,
  "age_days": 0,
  "networks_seen": 2,
  "guests_from_same_networks_24h": 4,
  "converted": false
}
```

## Privacy

Trust responses contain only booleans, coarse age bands, ages in whole hours/days, and aggregate counts. They never
contain an IP address or network identifier, email address, last-seen timestamp, service user id, or the identity of a
linked account. The same-network guest field is only a count. Do not use these signals as a substitute for a direct
authorization check.
