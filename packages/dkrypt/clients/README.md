# dkrypt API clients

The API key SDKs use dkrypt's public decrypt, job status, and IPA artifact routes. They never call dashboard or billing endpoints and send the API key only to the configured dkrypt origin. Use HTTPS for remote instances; plain HTTP is allowed only for localhost.

## Go

Import the source from the Go client folder or download the Go SDK archive. Create a client with the instance URL and API key, then call `Decrypt`, `GetJob`, `ListArtifacts`, or `DownloadArtifact`.

## Swift

Add `DkryptClient.swift` to an app target or download the Swift SDK archive. Use the async `decrypt`, `getJob`, `listArtifacts`, and `downloadArtifact` methods.

## Rust

Copy the Rust client folder into a Cargo workspace or download its archive. The crate uses Tokio-compatible async methods and reqwest.

## API collections

Import `postman.collection.json` in Postman or import the Bruno archive. Set the collection's `baseUrl` and `apiKey` values locally.
