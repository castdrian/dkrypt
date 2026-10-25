# Local API sandbox

Run `bun run api:mock` from `packages/dkrypt` to start a deterministic mock API at `http://127.0.0.1:4179`. The fixed local key is `mock-dkrypt-key`. It accepts decrypt requests, supports idempotency keys, advances job state on each status read, returns synthetic artifact metadata, and supports the `X-Dkrypt-Mock-Scenario: failure` header for a predictable failed job.

Every sandbox response carries `X-Dkrypt-Sandbox: true`. Downloaded files are plain-text placeholders, not IPA files and not installable. The mock binds only to loopback and never calls Apple, Stripe, TestFlight, a device, or a dkrypt server. Keep this server on the local machine; it is a test fixture, not a deployment mode.
