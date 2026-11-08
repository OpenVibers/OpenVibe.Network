# Account email addresses

Each account can keep up to eleven addresses, including its primary recovery address. Network verifies each address with a single-use link that expires after one hour. Pending addresses are limited to five per account; verification sends are rate limited per account and address.

On `openvibe.my`, **Email addresses** lets a person add, verify, remove, or make an address primary. A primary address must be verified; Network asks for fresh verification if it was last verified more than 90 days ago. A primary change updates the account's recovery and notice address, records an audit entry, and notifies the former primary address.

The authenticated person's API is `GET` and `POST /api/v1/me/emails`, `POST /api/v1/me/emails/:id/verify`, `POST /api/v1/me/emails/:id/primary`, and `DELETE /api/v1/me/emails/:id`. Existing sign-in and recovery flows continue to use the primary address.
