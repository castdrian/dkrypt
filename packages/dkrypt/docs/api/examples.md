# Public API examples

Generated API keys are scoped to decrypts, job status, and IPA artifacts. Store the key in an environment variable and never commit it.

## curl

```sh
export DKRYPT_API_URL=https://ipa.dylib.dev
export DKRYPT_API_KEY=dk_live_your_key

curl --fail-with-body -X POST "$DKRYPT_API_URL/v1/decrypts" \
  -H "Authorization: Bearer $DKRYPT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"bundleId":"com.example.app"}'
```

The response contains the job ID. Wait for progress with `GET /v1/jobs/{id}/wait?timeoutSeconds=25`; repeat only when the response is `202`. `POST /v1/jobs/status` accepts up to 100 IDs for a single batch.

## Python

```python
import os
import requests

base_url = os.environ["DKRYPT_API_URL"].rstrip("/")
headers = {"Authorization": f"Bearer {os.environ['DKRYPT_API_KEY']}"}
response = requests.post(
    f"{base_url}/v1/decrypts",
    headers={**headers, "Idempotency-Key": "my-unique-request-001"},
    json={"bundleId": "com.example.app"},
    timeout=30,
)
response.raise_for_status()
job = response.json()
print(job["id"], job["status"])
```

## TypeScript

```ts
const response = await fetch(`${process.env.DKRYPT_API_URL}/v1/decrypts`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.DKRYPT_API_KEY}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  },
  body: JSON.stringify({ bundleId: 'com.example.app' }),
});
if (!response.ok) throw new Error((await response.json()).message);
const job = await response.json();
```

## CLI

The Node-based CLI source is in [`packages/dkrypt-cli`](../../../dkrypt-cli/README.md). It uses only the same public API operations and rejects cross-origin redirects.

## Local mock API

Run `bun run api:mock` from `packages/dkrypt`, then point a test client at `http://127.0.0.1:4179` with key `mock-dkrypt-key`. The mock accepts decrypt requests, completes them after a short delay, and never opens an Apple connection, downloads an IPA, or creates a payment.
