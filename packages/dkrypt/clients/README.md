# dkrypt API clients

The API key SDKs use dkrypt's public decrypt, job status, and IPA artifact routes. They never call dashboard or billing endpoints and send the API key only to the configured dkrypt origin. Use HTTPS for remote instances; plain HTTP is allowed only for localhost.

## Go

Import the source from the Go client folder or download the Go SDK archive. The Go client supports App Store and TestFlight decrypts, latest-release resolution without creating a job, long polling, job status batches, event streams, artifact search, and downloads verified against the reported size and SHA-256. API failures include typed status, error code, request ID, retry timing, and a recovery hint. Downloads are verified before their bytes are returned.

## Swift

Add `DkryptClient.swift` to an app target or download the Swift SDK archive. Use `resolveRelease` to resolve the latest App Store or TestFlight build, `decrypt` and `waitForJob` to run a job, and `listArtifacts` and `downloadArtifact` to retrieve results. Both download methods verify the reported byte count and SHA-256 before returning data or promoting a file.

## Rust

Copy the Rust client folder into a Cargo workspace or download its archive. The crate uses Tokio-compatible async methods and reqwest.

## API collections

Import `postman.collection.json` in Postman or import the Bruno archive. Set the collection's `baseUrl` and `apiKey` values locally.
