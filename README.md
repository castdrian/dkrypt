# dkrypt

Self-hosted App Store and TestFlight decryption for jailbroken iPhone and iPad devices.

dkrypt provides an authenticated dashboard for managing decrypts, IPA artifacts, devices, TestFlight subscriptions, and billing, plus a narrow public API for decrypt workflows and IPA artifact access.

## Quick start

1. Clone the repository and copy `.env.example` to `.env`.
2. Set `API_KEY`, `SESSION_SIGNING_SECRET`, and `ADMIN_PASSWORD` to long random values.
3. Connect the iPhone or iPad over USB, unlock it, and accept the trust prompt.
4. Start dkrypt:

   ```sh
   docker volume create dkrypt_device_ssh
   docker compose up -d --build
   ```

5. Open `http://localhost:8080`, sign in, open **Settings → Devices**, select the discovered device, and choose **Set up**.

The setup flow pairs the device, verifies iOS and the jailbreak, checks ElleKit and autoinstall, installs dkrypt's SSH public key through the authenticated device agent, verifies SSH/SFTP for decrypts, and stores the device record. A device does not need an `.ipadecrypt` directory or a setup CLI command to be recognized.

## Requirements

- Docker Engine with Compose v2
- Linux host access to `/dev/bus/usb` for USB devices
- A rootless jailbreak with ElleKit
- The dkrypt autoinstall package installed on the device
- OpenSSH with its SFTP subsystem enabled for decrypts; device discovery and recovery do not depend on SSH
- An App Store Apple ID; TestFlight jobs also need TestFlight access

The image contains the Rust device bridge, the pinned `idevice` revision, and the pinned `netmuxd` release. USB discovery, pairing, reconnects, and local service tunnels are owned by the bridge; the host does not need Apple device CLI tools or a mounted mux socket.

<details>
<summary>Initial device package installation</summary>

The dashboard manages pairing and readiness after autoinstall is present. Installing or repairing the package still needs an SSH-capable path once, because the package is the device-side execution layer.

```sh
AUTOINSTALL_IDEVICE_TARGET=mobile@<device-address> \
AUTOINSTALL_IDEVICE_KEY="$HOME/.ssh/id_ed25519" \
make autoinstall-deploy
```

After installation, reconnect the device over USB and finish **Settings → Devices → Set up**. The SSH key is not used as the USB discovery or recovery dependency. For USB decrypts, dkrypt opens a Rust-managed local service tunnel and only uses SSH credentials for the `ipadecrypt` compatibility channel.

</details>

<details>
<summary>Wi-Fi devices and recovery</summary>

Wi-Fi devices must already be paired and reachable on the host network. The Rust bridge uses the paired device transport and mDNS discovery; allow local multicast discovery when the host firewall or container network is restricted. USB devices remain discoverable and recoverable when device-side SSH or Wi-Fi is unavailable.

If the device is temporarily absent, dkrypt keeps the record and marks the affected subsystem as recovering or offline. It does not erase the device or enter maintenance mode solely because the SSH/SFTP channel needed by one decrypt is unavailable.

</details>

<details>
<summary>Self-hosting configuration</summary>

Copy `.env.example` to `.env` and configure the required values. The important runtime settings are:

| Setting | Purpose |
| --- | --- |
| `API_KEY` | Self-hosted service credential for direct API and health checks; separate from dashboard-generated user keys |
| `SESSION_SIGNING_SECRET` | Dashboard session signing |
| `ABUSE_SIGNAL_SECRET` | Stable key for pseudonymous signup and Free-tier network counters; use a separate random value of at least 32 characters |
| `TRUSTED_PROXY_ADDRESSES` | Exact proxy IPs or CIDRs whose forwarded client addresses Fastify may trust; never use a catch-all range |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Paired Cloudflare Turnstile keys required for every new OAuth account |
| `IPAPI_IS_KEY` | Optional free ipapi.is API key for up to 1,000 daily VPN, proxy, Tor, relay, hosting, and abuse lookups; used internally for signup and Free-tier decrypt risk checks |
| `IPINFO_TOKEN` | Optional legacy IPinfo token used when `IPAPI_IS_KEY` is unset or its service is temporarily unavailable |
| `ABUSE_BLOCKED_EMAIL_DOMAINS` | Comma-separated disposable email domains blocked for new accounts |
| `FREE_NETWORK_DECRYPT_LIMIT`, `FREE_ANONYMOUS_NETWORK_DECRYPT_LIMIT` | Rolling 30-day Free decrypt caps shared across an IPv4 `/24` or IPv6 `/56`; the lower cap applies to classified VPN/proxy/Tor/relay/hosting networks |
| `FREE_ADDRESS_DECRYPT_LIMIT`, `FREE_ANONYMOUS_ADDRESS_DECRYPT_LIMIT` | Rolling 30-day Free decrypt caps shared across one exact IP address; the lower cap applies to classified VPN/proxy/Tor/relay/hosting addresses |
| `BACKUP_MANIFEST_SECRET` | Stable key for encrypted backup manifests; keep it independent from session rotation |
| `BACKUP_MANIFEST_SECRET_PREVIOUS` | Comma-separated previous manifest keys retained while older snapshots still exist |
| `ADMIN_PASSWORD` | Local administrator sign-in |
| `PUBLIC_BASE_URL` | Public origin for OAuth, webhooks, and secure cookies |
| `GITHUB_OAUTH_CLIENT_ID` | GitHub sign-in application identifier |
| `GITHUB_OAUTH_CLIENT_SECRET` | Current GitHub sign-in secret |
| `GITHUB_OAUTH_CLIENT_SECRET_PREVIOUS` | Previous GitHub OAuth secret retained during a provider-supported rotation window |
| `DISCORD_OAUTH_CLIENT_ID` | Discord sign-in application identifier |
| `DISCORD_OAUTH_CLIENT_SECRET` | Current Discord sign-in secret |
| `DISCORD_OAUTH_CLIENT_SECRET_PREVIOUS` | Previous Discord OAuth secret retained during a provider-supported rotation window |
| `STRIPE_SECRET_KEY` | Current Stripe API secret key |
| `STRIPE_SECRET_KEY_PREVIOUS` | Previous Stripe API key tried only after an explicit HTTP 401 authentication rejection from the current key |
| `BILLING_GIFT_ENCRYPTION_SECRET` | Stable secret used to encrypt paid gift codes; keep it outside backups and preserve it when restoring billing data |
| `NOWPAYMENTS_API_KEY` | Current NOWPayments API credential |
| `NOWPAYMENTS_API_KEY_PREVIOUS` | Previous NOWPayments API key tried only after HTTP 401 from the current key |
| `APPSTORE_OFFLINE_AUTHENTICATION_TIMEOUT_SECONDS` | Maximum Apple Account sign-in time; defaults to 300 seconds and is bounded to 60–900 seconds |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | SMTP credentials and server used for optional email notifications |
| `SMTP_PASS_PREVIOUS` | Previous SMTP password used only after a permanent authentication rejection |
| `OUTBOUND_WEBHOOK_SECRET` | HMAC key for signing outgoing notification webhooks |
| `OUTBOUND_WEBHOOK_SECRET_PREVIOUS` | Previous HMAC key used during outbound webhook key rotation |
| `ARTIFACT_DIR` | IPA storage volume |
| `STATE_DIR` | SQLite database, pairing material, backups, and mirrors |

For a reverse proxy, preserve the browser-facing `Host` header. If the proxy rewrites it, set `PUBLIC_BASE_URL` to the exact external origin, including the scheme and port. Direct LAN access by IP address works without changing `PUBLIC_BASE_URL`, but OAuth callbacks and secure cookies still require the correct public origin.

<details>
<summary>Account-abuse controls</summary>

New OAuth accounts require a verified GitHub or Discord email. One account can be created per verified email in a 30-day window, configured disposable email domains are rejected, and signup velocity is limited using keyed hashes of the exact address, coarse network prefix, and short-lived first-party browser signal. Free decrypts also have account, exact-address, coarse-network, and short-lived browser-signal limits. Configure `ABUSE_SIGNAL_SECRET` independently so those hashes remain stable when rotating the dashboard session key.

Cloudflare Turnstile is mandatory for every new OAuth account. Until both keys are configured, new account creation is blocked while existing users can still sign in. dkrypt also sets a random, signed, first-party browser signal for up to seven days. Turnstile's optional ephemeral identifier is stored as a separate short-lived signal, not a hardware ID. dkrypt does not read persistent hardware identifiers or build a browser fingerprint.

For network reputation checks, configure a free ipapi.is API key or an optional legacy IPinfo token. The configured provider receives the request IP when signup checks or a Free decrypt need a missing classification; dkrypt caches only VPN, proxy, Tor, relay, residential-proxy, hosting, anonymous-network, and abuse flags against a keyed exact-address hash for up to 12 hours. Classified networks receive lower signup and Free-tier limits rather than an automatic ban. If classification is configured but temporarily unavailable, dkrypt applies those lower limits until a lookup succeeds. The dashboard doctor reports which optional controls are configured without exposing keys.

If dkrypt is behind a reverse proxy, set `TRUSTED_PROXY_ADDRESSES` to that proxy's exact IP or narrow CIDR so rate limits use the real client network. dkrypt rejects catch-all proxy trust settings because they let clients forge forwarded IP headers. Shared limits use both one exact address and an IPv4 `/24` or IPv6 `/56` range; set the values high enough for households, offices, and schools that legitimately share a network.

</details>

The Bun API runs as an unprivileged service account; the USB bridge retains root access for direct device transport, with a small root supervisor managing both processes. Startup migrates existing state and artifact volume permissions once and keeps pairing records root-only. dkrypt creates its own Ed25519 SSH key in a separate persistent `dkrypt_device_ssh` Docker volume; it does not import or scan the host's personal SSH keys. USB setup installs the public half through the authenticated device agent and only reports decrypt readiness after SSH and SFTP respond. Preserve this volume across container replacements. If it is deleted, run USB setup again so the device can authorize the newly generated key. Protect access to the volume like any other service credential. Use an HTTPS reverse proxy when exposing the dashboard beyond localhost.

Outgoing notification webhooks include `X-Dkrypt-Event`, `X-Dkrypt-Timestamp`, and `X-Dkrypt-Signature`. The signature is `sha256=` followed by the HMAC-SHA256 hex digest of `<timestamp>.<raw JSON body>`. During rotation, set `OUTBOUND_WEBHOOK_SECRET` to the new key and `OUTBOUND_WEBHOOK_SECRET_PREVIOUS` to the old key; dkrypt sends the old-key signature in `X-Dkrypt-Signature-Previous` over the same timestamp and body. Configure receivers to accept either signature, reject stale timestamps, and compare signatures in constant time. Remove the previous key after every receiver accepts the current key.

For SMTP rotation, set `SMTP_PASS` to the new password and `SMTP_PASS_PREVIOUS` to the old one. Email delivery tries the previous password only when the server definitively rejects the current password with SMTP 535; network and temporary SMTP failures are not retried with another credential. Successful fallback is logged without including either password. Remove the previous password after confirming current-credential delivery. GitHub and Discord OAuth callbacks similarly try their previous client secret only for the provider's explicit invalid-client-secret response, never for an invalid authorization code or network error. Keep previous OAuth secrets only while the provider still accepts them; some providers invalidate a secret immediately when it is regenerated.

For NOWPayments API-key rotation, set `NOWPAYMENTS_API_KEY` to the new key and `NOWPAYMENTS_API_KEY_PREVIOUS` to the old key during the overlap window. dkrypt retries with the previous key only after an HTTP 401; permission, server, and network failures are not retried with another credential. Successful fallback is logged without exposing either key. Remove the previous key after confirming requests use the current credential.

For Stripe API-key rotation, set `STRIPE_SECRET_KEY` to the new key and `STRIPE_SECRET_KEY_PREVIOUS` to the old key during the overlap window. Both keys must belong to the same test or live mode. dkrypt retries with the previous key only after Stripe explicitly rejects the current key with HTTP 401; permission, server, and network failures are not retried with another credential. The manager configuration doctor reports invalid or cross-mode key pairs. Successful fallback is logged without exposing either key. Remove the previous key after confirming requests use the current credential.

The SQLite database uses WAL mode, foreign keys, migration checksums, integrity checks, and an atomic pre-migration backup. Startup fails closed when the database or migration checksums are invalid. Before updating a self-hosted deployment, run `cd packages/dkrypt && bun run db:migrate:dry-run` to exercise the pending migrations against a temporary database copy and verify restore integrity; the live database is not changed. The dashboard doctor is available to managers at `/v1/dashboard/doctor` and reports recommended CPU, memory, and temporary-storage capacity for the configured offline workers.

To update a source checkout:

```sh
git pull --ff-only origin main
docker compose up -d --build
```

For an immutable image update with an automatic database snapshot and health-checked rollback, run:

```sh
scripts/dkrypt-update.sh ghcr.io/<owner>/<repository>@sha256:<image-digest>
```

The helper asks before restarting the service. Pass `--yes` as the second argument for unattended use after reviewing the target digest. It keeps a verified SQLite copy in the state volume and restores both the prior image and database if the new container does not become healthy.

</details>

<details>
<summary>OpenTelemetry export</summary>

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to a collector base URL to send traces and metrics to its `/v1/traces` and `/v1/metrics` paths. Signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` values are sent to exactly the URLs provided. Configure shared or signal-specific authorization headers with the matching `OTEL_EXPORTER_OTLP_*_HEADERS` variables as comma-separated `name=value` pairs. Device reconnect metrics come from the Rust bridge's native usbmuxd attach/detach events; `device_bridge_event_stream_connected` reports whether that event feed is live.

dkrypt sends OTLP over HTTP using JSON encoding. Exported metrics include job queue and decrypt duration, device availability and reconnects, bridge and agent health, TestFlight lookup performance, artifact and device storage pressure, and webhook reconciliation. The internal `GET /v1/metrics` endpoint provides Prometheus text format to dkrypt's service credential and is unavailable to generated API keys.

The pending span queue is bounded by `OTEL_BSP_MAX_QUEUE_SIZE` (default `2048`). Spans are dropped when the queue is full or when retrying a failed batch would exceed the limit; older failed spans take priority over newer queued spans. The `dkrypt_telemetry_spans_dropped_total` metric reports discarded spans.

</details>

<details>
<summary>Backups and restore checks</summary>

Backups include the legacy export, a verified SQLite copy, and an encrypted checksum manifest. Set a stable `BACKUP_MANIFEST_SECRET` so session-secret rotation does not invalidate snapshots. When rotating the manifest secret, keep the old value in `BACKUP_MANIFEST_SECRET_PREVIOUS` until every snapshot encrypted with it has expired or been removed. The backup scheduler can be configured in the dashboard. A restore drill opens the SQLite copy in a temporary database and verifies its integrity, schema migration checksums, state snapshot, and manifest hashes before it is reported healthy.

Do not copy database files while the service is running. Use the dashboard backup action or stop the service before making an external volume snapshot.

</details>

<details>
<summary>Stripe billing</summary>

Stripe remains the card and bank payment path. Configure the live Stripe secret, recurring price IDs, webhook secret, and tax settings in the runtime environment. Set `BILLING_GIFT_ENCRYPTION_SECRET` to a stable random secret of at least 32 characters to enable one-time paid gift codes; keep it outside backups and preserve it when restoring billing data so gift codes can still be revealed to their purchasers. Rotate API keys with `STRIPE_SECRET_KEY_PREVIOUS` during the overlap window; webhook signing-secret rotation remains separate. Stripe readiness is visible in the manager billing view and the configuration doctor.

The current catalog has six tiers: Access (€2.50, two new decrypts per rolling 24 hours), Standard (€5, ten), Plus (€10, 25), Developer (€15, 50 and 30 API requests/minute), Unlimited (€20, unlimited and 60 API requests/minute), and Unlimited Priority (€30, unlimited, 120 API requests/minute, and higher queue priority). Every new tier includes IPA Library access. Library downloads, exact cached results, duplicate active jobs, and internal retries do not use a decrypt slot. API limits are per account across all keys, in addition to key-specific limits.

Keep the four original `STRIPE_*_PRICE_ID` values configured for grandfathered subscribers. Create six new monthly EUR prices and set `STRIPE_ACCESS_PRICE_ID`, `STRIPE_STANDARD_PRICE_ID`, `STRIPE_PLUS_PRICE_ID`, `STRIPE_DEVELOPER_PRICE_ID`, `STRIPE_UNLIMITED_PRICE_ID`, and `STRIPE_UNLIMITED_PRIORITY_PRICE_ID`. `BILLING_CATALOG_ROLLOUT=off` continues to offer the original catalog; `canary` offers the new catalog only to the comma-separated account IDs in `BILLING_CATALOG_CANARY_USER_IDS`; `all` offers it to everyone. Do not remove the old price mappings while any grandfathered subscription remains. Switching away from a legacy plan is voluntary and irreversible.

</details>

<details>
<summary>Crypto billing</summary>

Crypto billing is an optional second payment method using NOWPayments hosted invoices. It supports the configured EUR plans and selected crypto assets without custody or private-key storage in dkrypt. Crypto checkout does not ask for Stripe billing-address data. dkrypt checks the provider's minimum EUR-equivalent amount for each asset when showing checkout choices and rechecks at invoice creation; a tier below the minimum remains available by Stripe at its advertised price.

Keep it disabled until the provider dashboard, wallet, IPN secret, webhook URL, and settlement settings are ready:

```text
CRYPTO_BILLING_ENABLED=true
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...
NOWPAYMENTS_API_BASE_URL=https://api.nowpayments.io/v1
NOWPAYMENTS_ENVIRONMENT=live
NOWPAYMENTS_SUPPORTED_ASSETS=USDC
NOWPAYMENTS_DEFAULT_ASSET=USDC
NOWPAYMENTS_OUTCOME_CURRENCY=USDCBASE
NOWPAYMENTS_PRICE_CURRENCY=EUR
```

Set the supported and default assets to exact currency codes enabled in your NOWPayments account, and set the outcome currency to the wallet currency configured there. The example accepts USDC and settles to USDC on Base. Set the IPN destination to `https://<your-host>/v1/nowpayments/webhook`. The provider webhook is durable, deduplicated, and replayable by managers. Crypto payments have provider-specific refund and tax handling; they do not inherit Stripe Managed Payments or Stripe merchant-of-record treatment.

</details>

<details>
<summary>API</summary>

Dashboard-generated API keys use `Authorization: Bearer <generated-key>` and cover decrypt workflows, job status, and IPA artifacts only. Dashboard requests use the signed-in session. The self-hosted `API_KEY` setting is a separate service credential and is not a dashboard-generated user key.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/decrypt` | Request a decrypt and stream the completed IPA |
| `POST /v1/decrypts` | Queue a decrypt by release selector |
| `POST /v1/testflight/decrypt` | Queue a TestFlight build decrypt |
| `GET /v1/jobs/:id` | Read job status, attempts, deadline, warnings, and transport evidence |
| `GET /v1/jobs/:id/wait` | Wait up to 25 seconds for a job update, then poll again if it is still running |
| `POST /v1/jobs/status` | Read up to 100 job IDs in one status request |
| `GET /v1/artifacts` | List IPA artifacts |
| `GET /v1/artifacts/:id` | Read IPA artifact metadata |
| `GET /v1/artifacts/:id/file` | Download an IPA artifact |

Public API responses include `X-Dkrypt-API-Version: 1`. The [compatibility policy](packages/dkrypt/docs/api/compatibility.md) describes response stability and deprecation windows. Find [curl, Python, TypeScript, CLI, and local mock examples](packages/dkrypt/docs/api/examples.md). The local simulator listens only on `127.0.0.1`, accepts the fixed `mock-dkrypt-key`, and never contacts Apple or a payment provider.

GitHub workflows can use the [dkrypt decrypt action](action.yml) to submit a decrypt, wait for its result, and download the IPA. Pin a released version:

```yaml
- uses: castdrian/dkrypt@v1.3.0
  id: decrypt
  with:
    api-key: ${{ secrets.DKRYPT_API_KEY }}
    bundle-id: com.example.app
```

The action verifies the downloaded IPA’s SHA-256 and byte count against dkrypt before placing it at `path`. Interrupted downloads resume from the last received byte and are checked against the full artifact hash before promotion. It exposes `job-id`, `artifact-id`, `version`, `build`, `channel`, `is_testflight`, `cache_hit`, `sha256`, `size_bytes`, and `path`. Transient network errors, HTTP 429, and server errors retry with backoff; jobs can wait up to 30 minutes by default.

Set `channel: testflight` and omit `version` to resolve the latest available TestFlight build. Set `version` to an exact selector such as `352.0_118977` to request a specific build. To download an existing result without submitting a decrypt, pass `artifact-id` or `latest-cached-channel: testflight` (or `appstore`). These artifact modes are mutually exclusive with each other and with a new decrypt request. Use an API key with decrypt and artifact access, and TestFlight scope when requesting TestFlight builds.

Set `resolve-only: 'true'` to return the matching release version, build, channel, and cache status without creating a job or downloading an IPA. To process several apps in one step, pass `bundle-ids` as a JSON array; the action records per-app outcomes in `results-json`, adds a workflow summary table, and fails the step if any app fails. The output `path` for each successful download is included in that app’s result.

Use `lockfile: dkrypt.lock` to pin each app to its resolved source, version, and build. The file is JSON with a `version` value of `1` and an `apps` object keyed by bundle ID. Run the action with `update-lockfile: 'true'` and `resolve-only: 'true'` to resolve the selected releases and write their exact metadata; check the resulting `dkrypt.lock` into the repository. Later runs read the pin, reject conflicting `channel` or `version` inputs, and verify the resolved artifact’s source, version, and build before downloading it. `bundle-ids` uses the same per-app lock entries.

```json
{
  "version": 1,
  "apps": {
    "com.example.app": {
      "source": "testflight",
      "resolvedVersion": "352.0_118977",
      "build": "118977"
    }
  }
}
```

For independent jobs per app, use a GitHub Actions matrix:

```yaml
name: decrypt-matrix
on:
  workflow_dispatch:
jobs:
  decrypt:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        bundle_id:
          - com.example.app
          - com.example.another
    steps:
      - uses: castdrian/dkrypt@v1.3.0
        id: decrypt
        with:
          api-key: ${{ secrets.DKRYPT_API_KEY }}
          bundle-id: ${{ matrix.bundle_id }}
          channel: testflight
```

The action can also publish an already verified IPA to a GitHub Release. Grant `contents: write`, set `publish-to-release: 'true'`, pass `github-token: ${{ github.token }}` and an existing `release-tag`. Release creation is opt-in with `create-release: 'true'`; in a matrix, create the release in a separate job before parallel uploads. The action refuses an existing asset with the same name and returns `release-url` and `release-asset-url`.

```yaml
name: publish-decrypted-ipa
on:
  workflow_dispatch:
permissions:
  contents: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: castdrian/dkrypt@v1.3.0
        with:
          api-key: ${{ secrets.DKRYPT_API_KEY }}
          bundle-id: com.example.app
          publish-to-release: 'true'
          github-token: ${{ github.token }}
          release-tag: ${{ github.ref_name }}
```

For Fastlane, use the local plugin in [fastlane-plugin-dkrypt](fastlane-plugin-dkrypt/README.md). It submits App Store or TestFlight jobs and only exposes the downloaded IPA after size and SHA-256 verification. The generated [Swift client](packages/dkrypt/clients/swift/DkryptClient.swift) supports release resolution, job waiting, artifact listing, and verified downloads; [download its SDK archive](packages/dkrypt/web/public/downloads/dkrypt-swift-sdk.zip).

The dashboard artifact inspector includes an analyze-only IPA upload, executable compatibility details, signing and provisioning summaries, and an image asset browser. Analyze-only uploads are temporary and do not queue a decrypt or add an artifact to the library. Artifact notes are private to the signed-in account.

Dashboard, billing, account, session, health, and administration routes are internal to dkrypt and are not available to generated API keys. The public OpenAPI document is available at `/openapi.json` and the Scalar reference UI at `/reference`.

Administrators can configure exact GitHub Actions OIDC trust policies in Settings → System Doctor. A policy pins the numeric repository ID, workflow ref, Git ref or environment, audience, project, and bundle IDs. A workflow requests an ID token for that audience and sends it as a Bearer token to the existing decrypt, job-status, or IPA artifact routes. Tokens are verified against GitHub's signing keys and grant no dashboard access. No OIDC policy is active until an administrator creates one.

Administrators can also create a signed decrypt trigger in System Doctor. Send `POST /v1/integrations/decrypt-trigger/<integration-id>` with a JSON body containing `bundleId`, `source` (`appstore` or `testflight`), and optionally `version`. TestFlight requires a version with a build number such as `1.2_345`. Include `X-Dkrypt-Timestamp` as Unix milliseconds, `X-Dkrypt-Event-Id` as a unique delivery ID, and `X-Dkrypt-Signature` as the lowercase hex HMAC-SHA256 of `<timestamp>.<event-id>.<exact raw JSON body>` using the secret shown once at creation or rotation. Signatures expire after five minutes. Duplicate event IDs never queue another decrypt. The endpoint uses its own signature authentication and is not available to generated API keys.

</details>

<details>
<summary>Development and deployment</summary>

```sh
cd packages/dkrypt
bun install --frozen-lockfile
bun test
bun run typecheck
bun run typecheck:web
cd ../device-bridge
cargo test --locked
cargo check --locked
```

The deployment workflow runs the Bun and Rust checks, builds an immutable GHCR image, starts the bridge with direct USB access, waits for database integrity and health, and rolls back to the previous image if readiness fails. The Rust bridge is cut over immediately after those gates; runtime fallback to the old C toolchain is not part of the production configuration.

The public API includes a [local deterministic sandbox](packages/dkrypt/docs/api/sandbox.md), [Apple Shortcuts setup](packages/dkrypt/docs/api/apple-shortcuts.md), and a [versioning and deprecation policy](packages/dkrypt/docs/api/lifecycle.md). An optional Helm chart is in `deploy/helm/dkrypt`. The CLI can generate Caddy, Nginx, and Traefik proxy examples with `dkrypt proxy-config`.

For a verified move to another Docker host, use the [encrypted host migration guide](docs/self-hosting/host-migration.md).

</details>

## License

See the repository license files.
