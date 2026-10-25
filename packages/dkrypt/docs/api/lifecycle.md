# Public API lifecycle

The generated API key surface is versioned under `/v1`. Existing routes remain compatible within a major version. New response fields and routes are additive. Requests and responses include `X-Dkrypt-API-Version`; rate-limited API responses include the legacy `X-RateLimit-*` fields and structured `RateLimit` and `RateLimit-Policy` metadata.

If dkrypt schedules a breaking route or behavior change, it will publish a deprecation notice for at least 180 days before removal. Affected responses will include `Deprecation`, `Sunset`, and a `Link` to the migration notice. The current policy is available at `GET /api-lifecycle.json` and in the `x-dkrypt-lifecycle` OpenAPI extension. An empty deprecation list means no public API removal is currently scheduled.

The API reference at `/reference` contains only API-key routes for decrypt requests, job status, and the IPA library. Dashboard, billing, session, health, and administration endpoints are not part of this public API.
