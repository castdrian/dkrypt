# Apple Shortcuts

Build a private Shortcut with the Shortcuts app's **Get Contents of URL** action. dkrypt does not need a companion app: the Shortcut calls the public API using an API key limited to decrypt, job status, and IPA library access.

Create a key in **Settings → API keys** with the decrypt and IPA library permissions. Store it in a Shortcut text action or ask for it at run time. Do not share a Shortcut containing a live key. Revoke the key in dkrypt if the Shortcut is shared accidentally.

## Submit an app

1. Add **Ask for Input** or **Get Clipboard** and name the result `Bundle ID`.
2. Add **Get Contents of URL** with `https://ipa.dylib.dev/v1/decrypts`.
3. Set the method to `POST`, request body to JSON, and add `Authorization: Bearer YOUR_API_KEY` and `Idempotency-Key: SHORTCUT_INPUT` headers. Use a UUID action or a stable value for a Shortcut run so retries do not create duplicate jobs.
4. Add the JSON body `{ "bundleId": "Bundle ID" }`. To request a specific release, include `"version": "VERSION"`.
5. Show the returned job ID. The job can continue in dkrypt if the Shortcut ends.

## Check progress

Use **Get Contents of URL** with `https://ipa.dylib.dev/v1/jobs/JOB_ID/wait?timeoutSeconds=25` and the same Authorization header. Repeat while the returned `status` is `queued` or `running`; the endpoint waits for up to 25 seconds each time. When a status is `done`, use the `artifactId` from the job response if present, or call `GET /v1/jobs/JOB_ID` to fetch the final status.

For a live progress flow, use `GET /v1/jobs/JOB_ID/events` with `Accept: text/event-stream` in an HTTP client that supports Server-Sent Events. Shortcuts' standard URL action is better suited to the bounded wait endpoint.

## Save an IPA

Use **Get Contents of URL** with `https://ipa.dylib.dev/v1/artifacts/ARTIFACT_ID/file`, set the Authorization header, then pass the response to **Save File**. Keep the API key private and use an explicit Files destination.

Replace `ipa.dylib.dev` with the public host of a self-hosted dkrypt instance. Its TLS certificate must be valid for the host.
