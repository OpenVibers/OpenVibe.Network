# Account email addresses

Each account can keep up to eleven addresses, including its primary recovery address. Network verifies each address with a single-use link that expires after one hour. Pending addresses are limited to five per account; verification sends are rate limited per account and address.

On `openvibe.my`, **Email addresses** lets a person add, verify, remove, or make an address primary. A primary address must be verified; Network asks for fresh verification if it was last verified more than 90 days ago. Making an address primary or removing one requires a sign-in from the last ten minutes. A primary change updates the account's recovery and notice address, records an audit entry, and notifies the former primary address.

The authenticated person's API is `GET` and `POST /api/v1/me/emails`, `POST /api/v1/me/emails/:id/verify`, `POST /api/v1/me/emails/:id/primary`, and `DELETE /api/v1/me/emails/:id`. Existing sign-in and recovery flows continue to use the primary address.

At OAuth consent, an app that requests the `email` scope asks the person to choose one verified address. The choice is stored for that app; `identity.emails.read` returns only that address. Services with the same capability can `POST /api/v1/identity/emails/verified-check` with `{ "subject": "usr_…", "email": "person@example.com" }` and receive only `{ "verified": true|false }`; an unknown subject and an unknown address both return `false`.
