# Public API compatibility

The generated API-key surface uses the `v1` compatibility level. Additive response fields and optional request fields may be introduced without changing the compatibility level. Existing fields keep their meaning and type within `v1`.

Every public response includes `X-Dkrypt-API-Version: 1`. Dashboard session routes, billing routes, account routes, and administration routes are not part of this public API.

No public `v1` route currently has a scheduled removal. Before a route or field is removed, dkrypt will document the replacement and migration example, add `Deprecation: true` and a `Sunset` date to affected responses, and allow at least 90 days between notice and removal. Security fixes and provider-mandated changes may require a shorter window; those changes will be called out in the release notes.

Use the `requestId` returned with API errors when reporting a failure. Clients should tolerate unknown response fields, handle `202` as accepted-but-still-running, and use the wait or batch-status endpoint instead of rapidly polling each job separately.
