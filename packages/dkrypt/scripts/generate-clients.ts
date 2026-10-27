import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { preserveOpenApiPathOrder } from './openapiPathOrder.js';

const stateDir = mkdtempSync(path.join('/tmp', 'dkrypt-client-generation-'));
process.env.API_KEY ??= 'client-generation-api-key';
process.env.SESSION_SIGNING_SECRET ??= 'client-generation-session-secret';
process.env.ADMIN_PASSWORD ??= 'client-generation-admin-password';
process.env.STATE_DIR = stateDir;
process.env.OUTPUT_DIR = path.join(stateDir, 'tmp');
process.env.ARTIFACT_DIR = path.join(stateDir, 'artifacts');

const { buildServer } = await import('../src/server.ts');
const { createPublicOpenApiDocument } = await import('../src/publicApi.ts');
const server = await buildServer({ includePublicRoutes: false });
await server.ready();
const document = createPublicOpenApiDocument(server.swagger());
const openApiPath = path.resolve(process.cwd(), 'clients', 'openapi.json');
if (existsSync(openApiPath)) {
  const previousDocument = JSON.parse(readFileSync(openApiPath, 'utf8')) as { paths?: Record<string, Record<string, unknown>> };
  document.paths = preserveOpenApiPathOrder(previousDocument.paths ?? {}, document.paths ?? {});
}
const routes = Object.entries(document.paths ?? {}).flatMap(([route, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${route}`)).sort();
const outputDirectory = path.resolve(process.cwd(), 'clients');
mkdirSync(path.join(outputDirectory, 'typescript'), { recursive: true });
mkdirSync(path.join(outputDirectory, 'python'), { recursive: true });
mkdirSync(path.join(outputDirectory, 'go'), { recursive: true });
mkdirSync(path.join(outputDirectory, 'swift'), { recursive: true });
mkdirSync(path.join(outputDirectory, 'rust', 'src'), { recursive: true });
writeFileSync(openApiPath, `${JSON.stringify(document, null, 2)}\n`);
writeFileSync(path.join(outputDirectory, 'typescript', 'dkrypt.ts'), renderTypeScript(routes));
writeFileSync(path.join(outputDirectory, 'python', 'dkrypt_client.py'), renderPython(routes));
writeFileSync(path.join(outputDirectory, 'go', 'go.mod'), renderGoModule());
writeFileSync(path.join(outputDirectory, 'go', 'dkrypt.go'), renderGoClient());
writeFileSync(path.join(outputDirectory, 'go', 'dkrypt_test.go'), renderGoClientTests());
writeFileSync(path.join(outputDirectory, 'swift', 'DkryptClient.swift'), renderSwiftClient());
writeFileSync(path.join(outputDirectory, 'rust', 'Cargo.toml'), renderRustManifest());
writeFileSync(path.join(outputDirectory, 'rust', 'src', 'lib.rs'), renderRustClient());
writeFileSync(path.join(outputDirectory, 'postman.collection.json'), `${JSON.stringify(renderPostmanCollection(document), null, 2)}\n`);
writeFileSync(path.join(outputDirectory, 'README.md'), renderClientReadme());
const downloadsDirectory = path.resolve(process.cwd(), 'web', 'public', 'downloads');
mkdirSync(downloadsDirectory, { recursive: true });
writeFileSync(path.join(downloadsDirectory, 'dkrypt-postman.json'), `${JSON.stringify(renderPostmanCollection(document), null, 2)}\n`);
writeFileSync(path.join(downloadsDirectory, 'dkrypt-bruno.zip'), renderBrunoCollection(document));
writeFileSync(path.join(downloadsDirectory, 'dkrypt-go-sdk.zip'), renderSdkArchive([
  [path.join(outputDirectory, 'go', 'go.mod'), 'dkrypt-go/go.mod'],
  [path.join(outputDirectory, 'go', 'dkrypt.go'), 'dkrypt-go/dkrypt.go'],
  [path.join(outputDirectory, 'go', 'dkrypt_test.go'), 'dkrypt-go/dkrypt_test.go'],
]));
writeFileSync(path.join(downloadsDirectory, 'dkrypt-swift-sdk.zip'), renderSdkArchive([
  [path.join(outputDirectory, 'swift', 'DkryptClient.swift'), 'dkrypt-swift/DkryptClient.swift'],
]));
writeFileSync(path.join(downloadsDirectory, 'dkrypt-rust-sdk.zip'), renderSdkArchive([
  [path.join(outputDirectory, 'rust', 'Cargo.toml'), 'dkrypt-rust/Cargo.toml'],
  [path.join(outputDirectory, 'rust', 'src', 'lib.rs'), 'dkrypt-rust/src/lib.rs'],
]));
await server.close();

function renderSdkArchive(files: Array<[string, string]>): Buffer {
  const archive = new AdmZip();
  for (const [filePath, archivePath] of files) archive.addFile(archivePath, readFileSync(filePath));
  return archive.toBuffer();
}

function renderClientReadme(): string {
  return `# dkrypt API clients

The API key SDKs use dkrypt's public decrypt, job status, and IPA artifact routes. They never call dashboard or billing endpoints and send the API key only to the configured dkrypt origin. Use HTTPS for remote instances; plain HTTP is allowed only for localhost.

## Go

Import the source from the Go client folder or download the Go SDK archive. The Go client supports App Store and TestFlight decrypts, latest-release resolution without creating a job, long polling, job status batches, event streams, artifact search, and downloads verified against the reported size and SHA-256. API failures include typed status, error code, request ID, retry timing, and a recovery hint. Downloads are verified before their bytes are returned.

## Swift

Add \u0060DkryptClient.swift\u0060 to an app target or download the Swift SDK archive. Use \u0060resolveRelease\u0060 to resolve the latest App Store or TestFlight build, \u0060decrypt\u0060 and \u0060waitForJob\u0060 to run a job, and \u0060listArtifacts\u0060 and \u0060downloadArtifact\u0060 to retrieve results. Both download methods verify the reported byte count and SHA-256 before returning data or promoting a file.

## Rust

Copy the Rust client folder into a Cargo workspace or download its archive. The crate uses Tokio-compatible async methods and reqwest.

## API collections

Import \u0060postman.collection.json\u0060 in Postman or import the Bruno archive. Set the collection's \u0060baseUrl\u0060 and \u0060apiKey\u0060 values locally.
`;
}

function renderGoModule(): string {
  return 'module github.com/castdrian/dkrypt/clients/go\n\ngo 1.22\n';
}

function renderGoClient(): string {
  return readFileSync(path.resolve(process.cwd(), 'scripts/templates/dkrypt.go.template'), 'utf8');
}

function renderGoClientTests(): string {
  return readFileSync(path.resolve(process.cwd(), 'scripts/templates/dkrypt_test.go.template'), 'utf8');
}

function renderSwiftClient(): string {
  return `import Foundation
import CryptoKit

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum DkryptChannel: String, Sendable {
    case appStore = "appstore"
    case testFlight = "testflight"
}

public struct DkryptJob: Decodable, Sendable {
    public let id: String
    public let status: String
    public let progress: String?
    public let error: String?
    public let artifactId: String?
}

public struct DkryptArtifact: Decodable, Sendable {
    public let id: String
    public let bundleId: String
    public let channel: String?
    public let versionLabel: String?
    public let buildNumber: String?
    public let sizeBytes: Int64?
    public let sha256: String?
    public let fileUrl: String?
}

public struct DkryptArtifactPage: Decodable, Sendable {
    public let artifacts: [DkryptArtifact]
    public let nextCursor: String?
}

public struct DkryptResolvedRelease: Decodable, Sendable {
    public let bundleId: String
    public let channel: String
    public let resolvedVersion: String
    public let isTestFlight: Bool
    public let build: String?
    public let cacheHit: Bool
    public let artifact: DkryptArtifact?
}

public struct DkryptClient: Sendable {
    public let baseURL: URL
    public let apiKey: String?
    public let session: URLSession

    public init(baseURL: URL, apiKey: String? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.session = session
    }

    public func decrypt(bundleId: String, version: String? = nil, channel: DkryptChannel = .appStore, idempotencyKey: String = UUID().uuidString) async throws -> DkryptJob {
        var body: [String: Any] = ["bundleId": bundleId, "channel": channel.rawValue]
        if let version { body["version"] = version }
        let encoded = try JSONSerialization.data(withJSONObject: body)
        return try await request("/v1/decrypts", method: "POST", body: encoded, idempotencyKey: idempotencyKey)
    }

    public func resolveRelease(bundleId: String, version: String? = nil, channel: DkryptChannel = .appStore) async throws -> DkryptResolvedRelease {
        var body: [String: Any] = ["bundleId": bundleId, "channel": channel.rawValue, "resolveOnly": true]
        if let version { body["version"] = version }
        return try await request("/v1/decrypts", method: "POST", body: try JSONSerialization.data(withJSONObject: body))
    }

    public func getJob(id: String) async throws -> DkryptJob {
        try await request("/v1/jobs/" + Self.pathComponent(id))
    }

    public func waitForJob(id: String, timeout: TimeInterval = 1800) async throws -> DkryptJob {
        let deadline = Date().addingTimeInterval(max(1, min(timeout, 86_400)))
        var job = try await getJob(id: id)
        while job.status != "done" && job.status != "failed" {
            let remaining = Int(deadline.timeIntervalSinceNow.rounded(.down))
            guard remaining > 0 else { throw URLError(.timedOut) }
            let waitSeconds = min(25, remaining)
            job = try await request("/v1/jobs/\\(Self.pathComponent(id))/wait?timeoutSeconds=\\(waitSeconds)")
        }
        guard job.status == "done" else {
            throw NSError(domain: "DkryptClient", code: 1, userInfo: [NSLocalizedDescriptionKey: job.error ?? "dkrypt job failed"])
        }
        return job
    }

    public func getArtifact(id: String) async throws -> DkryptArtifact {
        try await request("/v1/artifacts/" + Self.pathComponent(id))
    }

    public func listArtifacts(query: String? = nil, limit: Int = 100, cursor: String? = nil) async throws -> DkryptArtifactPage {
        var components = URLComponents()
        components.path = "/v1/artifacts"
        var items = [URLQueryItem(name: "limit", value: String(max(1, min(100, limit))))]
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        components.queryItems = items
        return try await request(components.string ?? "/v1/artifacts")
    }

    public func downloadArtifact(id: String) async throws -> Data {
        let artifact = try await getArtifact(id: id)
        let data = try await requestData(artifact.fileUrl ?? "/v1/artifacts/\\(Self.pathComponent(id))/file")
        try Self.verify(data: data, artifact: artifact)
        return data
    }

    @discardableResult
    public func downloadArtifact(id: String, to destination: URL) async throws -> URL {
        let artifact = try await getArtifact(id: id)
        guard let expectedSize = artifact.sizeBytes, expectedSize > 0,
              let expectedHash = artifact.sha256?.lowercased(), expectedHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw NSError(domain: "DkryptClient", code: 2, userInfo: [NSLocalizedDescriptionKey: "dkrypt did not return valid IPA size and SHA-256 metadata"])
        }
        let path = artifact.fileUrl ?? "/v1/artifacts/\\(Self.pathComponent(id))/file"
        let request = try makeRequest(path, method: "GET", accept: "application/octet-stream")
        let (downloaded, response) = try await session.download(for: request)
        try Self.validate(response)
        let attributes = try FileManager.default.attributesOfItem(atPath: downloaded.path)
        guard let size = (attributes[.size] as? NSNumber)?.int64Value, size == expectedSize else {
            throw NSError(domain: "DkryptClient", code: 3, userInfo: [NSLocalizedDescriptionKey: "IPA size did not match dkrypt metadata"])
        }
        let handle = try FileHandle(forReadingFrom: downloaded)
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty { hasher.update(data: chunk) }
        try handle.close()
        let actualHash = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard actualHash == expectedHash else {
            throw NSError(domain: "DkryptClient", code: 4, userInfo: [NSLocalizedDescriptionKey: "IPA SHA-256 did not match dkrypt metadata"])
        }
        let directory = destination.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let staging = directory.appendingPathComponent(".\\(destination.lastPathComponent).\\(UUID().uuidString).partial")
        try FileManager.default.moveItem(at: downloaded, to: staging)
        if FileManager.default.fileExists(atPath: destination.path) {
            _ = try FileManager.default.replaceItemAt(destination, withItemAt: staging)
        } else {
            try FileManager.default.moveItem(at: staging, to: destination)
        }
        return destination
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil, idempotencyKey: String? = nil) async throws -> T {
        let data = try await requestData(path, method: method, body: body, idempotencyKey: idempotencyKey)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func requestData(_ path: String, method: String = "GET", body: Data? = nil, idempotencyKey: String? = nil) async throws -> Data {
        let request = try makeRequest(path, method: method, accept: "application/json", body: body, idempotencyKey: idempotencyKey)
        let (data, response) = try await session.data(for: request)
        try Self.validate(response, data: data)
        return data
    }

    private func makeRequest(_ path: String, method: String, accept: String, body: Data? = nil, idempotencyKey: String? = nil) throws -> URLRequest {
        let host = (baseURL.host ?? "").lowercased()
        let allowsHTTP = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard baseURL.scheme?.lowercased() == "https" || allowsHTTP else { throw URLError(.secureConnectionFailed) }
        guard var target = URLComponents(url: baseURL, resolvingAgainstBaseURL: false), let origin = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
        let relative = URLComponents(string: path)
        guard relative?.host == nil, relative?.scheme == nil else { throw URLError(.badURL) }
        target.path = relative?.path ?? path
        target.queryItems = relative?.queryItems
        guard target.scheme == origin.scheme, target.host == origin.host, target.port == origin.port, let url = target.url else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(accept, forHTTPHeaderField: "Accept")
        if let apiKey { request.setValue("Bearer " + apiKey, forHTTPHeaderField: "Authorization") }
        if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = body }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        return request
    }

    private static func validate(_ response: URLResponse, data: Data? = nil) throws {
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(response.statusCode) else {
            throw NSError(domain: "DkryptClient", code: response.statusCode, userInfo: [NSLocalizedDescriptionKey: String(decoding: data ?? Data(), as: UTF8.self)])
        }
    }

    private static func verify(data: Data, artifact: DkryptArtifact) throws {
        guard let expectedSize = artifact.sizeBytes, Int64(data.count) == expectedSize,
              let expectedHash = artifact.sha256?.lowercased(), expectedHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw NSError(domain: "DkryptClient", code: 3, userInfo: [NSLocalizedDescriptionKey: "IPA size or SHA-256 metadata is invalid"])
        }
        let actualHash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard actualHash == expectedHash else { throw NSError(domain: "DkryptClient", code: 4, userInfo: [NSLocalizedDescriptionKey: "IPA SHA-256 did not match dkrypt metadata"]) }
    }

    private static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
    }
}
`;
}

function renderRustManifest(): string {
  return `[package]
name = "dkrypt-client"
version = "0.1.0"
edition = "2021"

[dependencies]
reqwest = { version = "0.12", features = ["json", "rustls-tls"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
`;
}

function renderRustClient(): string {
  return `use reqwest::{Client, Method, Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::error::Error;

#[derive(Clone)]
pub struct DkryptClient {
    base_url: Url,
    api_key: Option<String>,
    http: Client,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub status: String,
    pub progress: Option<String>,
    pub error: Option<String>,
    pub artifact_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub bundle_id: String,
    pub version_label: Option<String>,
    pub file_size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPage {
    pub artifacts: Vec<Artifact>,
    pub next_cursor: Option<String>,
}

impl DkryptClient {
    pub fn new(base_url: &str, api_key: Option<String>) -> Result<Self, Box<dyn Error + Send + Sync>> {
        let base_url = Url::parse(base_url)?;
        let host = base_url.host_str().unwrap_or_default();
        let allows_http = ["localhost", "127.0.0.1", "::1"].contains(&host);
        if !["http", "https"].contains(&base_url.scheme()) || host.is_empty() { return Err("invalid dkrypt base URL".into()); }
        if base_url.scheme() == "http" && !allows_http { return Err("Use an HTTPS dkrypt URL; HTTP is allowed only for localhost".into()); }
        Ok(Self { base_url, api_key, http: Client::new() })
    }

    fn url(&self, path: &str) -> Result<Url, Box<dyn Error + Send + Sync>> {
        let target = self.base_url.join(path)?;
        if target.origin() != self.base_url.origin() { return Err("dkrypt requests must use the configured origin".into()); }
        Ok(target)
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>, idempotency_key: Option<&str>) -> Result<Response, Box<dyn Error + Send + Sync>> {
        let mut request = self.http.request(method, self.url(path)?).header("Accept", "application/json");
        if let Some(key) = &self.api_key { request = request.bearer_auth(key); }
        if let Some(key) = idempotency_key { request = request.header("Idempotency-Key", key); }
        if let Some(body) = body { request = request.json(&body); }
        let response = request.send().await?;
        if !response.status().is_success() { let status = response.status(); let detail = response.text().await.unwrap_or_default(); return Err(format!("dkrypt request failed with HTTP {status}: {detail}").into()); }
        Ok(response)
    }

    pub async fn decrypt(&self, bundle_id: &str, version: Option<&str>, idempotency_key: &str) -> Result<Job, Box<dyn Error + Send + Sync>> {
        let mut body = json!({"bundleId": bundle_id});
        if let Some(version) = version { body["version"] = json!(version); }
        Ok(self.send(Method::POST, "/v1/decrypts", Some(body), Some(idempotency_key)).await?.json().await?)
    }

    pub async fn get_job(&self, id: &str) -> Result<Job, Box<dyn Error + Send + Sync>> {
        let path = format!("/v1/jobs/{}", encode_path_component(id));
        Ok(self.send(Method::GET, &path, None, None).await?.json().await?)
    }

    pub async fn list_artifacts(&self, query: Option<&str>, limit: usize, cursor: Option<&str>) -> Result<ArtifactPage, Box<dyn Error + Send + Sync>> {
        let mut url = self.url("/v1/artifacts")?;
        { let mut params = url.query_pairs_mut(); params.append_pair("limit", &limit.clamp(1, 100).to_string()); if let Some(query) = query { params.append_pair("q", query); } if let Some(cursor) = cursor { params.append_pair("cursor", cursor); } }
        let path = url.path().to_string() + "?" + url.query().unwrap_or_default();
        Ok(self.send(Method::GET, &path, None, None).await?.json().await?)
    }

    pub async fn download_artifact(&self, id: &str) -> Result<Vec<u8>, Box<dyn Error + Send + Sync>> {
        let path = format!("/v1/artifacts/{}/file", encode_path_component(id));
        let mut request = self.http.get(self.url(&path)?).header("Accept", "application/octet-stream");
        if let Some(key) = &self.api_key { request = request.bearer_auth(key); }
        let response = request.send().await?;
        if !response.status().is_success() { let status = response.status(); let detail = response.text().await.unwrap_or_default(); return Err(format!("dkrypt download failed with HTTP {status}: {detail}").into()); }
        Ok(response.bytes().await?.to_vec())
    }
}

fn encode_path_component(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) { result.push(byte as char); }
        else { result.push_str(&format!("%{byte:02X}")); }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::DkryptClient;

    #[test]
    fn client_rejects_requests_to_a_different_origin() {
        let client = DkryptClient::new("https://dkrypt.example", None).expect("valid base URL");
        assert!(client.url("https://attacker.example/v1/jobs").is_err());
        assert!(client.url("//attacker.example/v1/jobs").is_err());
    }

    #[test]
    fn client_allows_plain_http_only_for_localhost() {
        assert!(DkryptClient::new("http://localhost:3000", None).is_ok());
        assert!(DkryptClient::new("http://127.0.0.1:3000", None).is_ok());
        assert!(DkryptClient::new("http://dkrypt.example", None).is_err());
    }
}
`;
}

function renderPostmanCollection(document: { paths?: Record<string, Record<string, unknown>> }): unknown {
  const items = Object.entries(document.paths ?? {}).flatMap(([path, methods]) => Object.keys(methods)
    .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase()))
    .map((method) => {
      const route = path.replace(/\{([^}]+)\}/g, '{{$1}}');
      const name = `${method.toUpperCase()} ${path}`;
      const request: Record<string, unknown> = {
        method: method.toUpperCase(),
        header: [{ key: 'Accept', value: 'application/json' }],
        url: { raw: `{{baseUrl}}${route}`, host: ['{{baseUrl}}'], path: route.split('/').filter(Boolean) },
      };
      if (method.toLowerCase() === 'post') {
        const example = path === '/v1/decrypts'
          ? { bundleId: 'com.example.app' }
          : path === '/v1/testflight/decrypt'
            ? { bundleId: 'com.example.app', appId: 123456789, build: { id: 987654321, cfBundleShortVersion: '1.0', cfBundleVersion: '42', bundleId: 'com.example.app' } }
            : path === '/v1/jobs/status'
              ? { ids: ['{{jobId}}'] }
              : undefined;
        if (example) request.body = { mode: 'raw', raw: JSON.stringify(example, null, 2), options: { raw: { language: 'json' } } };
      }
      return { name, request, response: [] };
    }));
  return {
    info: { name: 'dkrypt Public API', description: 'Public API-key operations for dkrypt decrypt jobs and IPA artifacts.', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{apiKey}}', type: 'string' }] },
    variable: [{ key: 'baseUrl', value: 'http://localhost:3000' }, { key: 'apiKey', value: '' }, { key: 'jobId', value: '' }],
    item: items,
  };
}

function renderBrunoCollection(document: { paths?: Record<string, Record<string, unknown>> }): Buffer {
  const archive = new AdmZip();
  archive.addFile('dkrypt/bruno.json', Buffer.from(JSON.stringify({ version: '1', name: 'dkrypt Public API', type: 'collection', ignore: ['node_modules', '.git'] }, null, 2) + '\n'));
  archive.addFile('dkrypt/environments/Local.bru', Buffer.from('vars {\n  baseUrl: http://localhost:3000\n  apiKey: replace-with-your-api-key\n  jobId: replace-with-a-job-id\n}\n'));
  let sequence = 0;
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const method of Object.keys(methods).filter((candidate) => ['get', 'post', 'put', 'patch', 'delete'].includes(candidate.toLowerCase()))) {
      sequence += 1;
      const route = path.replace(/\{([^}]+)\}/g, '{{$1}}');
      const name = `${method.toUpperCase()} ${path}`;
      const body = path === '/v1/decrypts'
        ? '\nbody:json {\n  {\n    "bundleId": "com.example.app"\n  }\n}\n'
        : path === '/v1/testflight/decrypt'
          ? '\nbody:json {\n  {\n    "bundleId": "com.example.app",\n    "appId": 123456789,\n    "build": { "id": 987654321, "cfBundleShortVersion": "1.0", "cfBundleVersion": "42", "bundleId": "com.example.app" }\n  }\n}\n'
          : path === '/v1/jobs/status'
            ? '\nbody:json {\n  { "ids": ["{{jobId}}"] }\n}\n'
            : '';
      const content = `meta {\n  name: ${name}\n  type: http\n  seq: ${sequence}\n}\n\n${method.toLowerCase()} {\n  url: {{baseUrl}}${route}\n  body: ${body ? 'json' : 'none'}\n  auth: bearer\n}\n\nauth:bearer {\n  token: {{apiKey}}\n}\n\nheaders {\n  Accept: application/json\n}\n${body}`;
      archive.addFile(`dkrypt/${String(sequence).padStart(2, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.bru`, Buffer.from(content));
    }
  }
  return archive.toBuffer();
}

function renderTypeScript(routes: string[]): string {
  const routeUnion = routes.map((route) => `  | ${JSON.stringify(route)}`).join('\n');
  return `export type DkryptRoute =
${routeUnion};

export interface DkryptClientOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
}

export interface DkryptRequestInit extends RequestInit {
  path: string;
}

export interface DkryptJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress?: string;
  error?: string;
  artifactId?: string;
}

export interface DkryptDecryptOptions {
  version?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface DkryptArtifactPage {
  artifacts: DkryptArtifact[];
  nextCursor?: string;
}

export interface DkryptArtifact {
  id: string;
  bundleId: string;
  versionLabel?: string;
  fileSizeBytes?: number;
  [key: string]: unknown;
}

export interface DkryptJobEventSnapshot {
  job: DkryptJob;
  events: Array<{ at: number; label: string; status: DkryptJob['status']; durationMs?: number }>;
}

export class DkryptClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryOptions: Required<NonNullable<DkryptClientOptions['retry']>>;

  constructor(baseUrl: string, options?: DkryptClientOptions);
  constructor(baseUrl: string, fetchImpl?: typeof fetch);
  constructor(baseUrl: string, optionsOrFetch: DkryptClientOptions | typeof fetch = {}) {
    const options = typeof optionsOrFetch === 'function' ? { fetchImpl: optionsOrFetch } : optionsOrFetch;
    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryOptions = {
      maxAttempts: Math.max(1, Math.min(5, Math.floor(options.retry?.maxAttempts ?? 3))),
      baseDelayMs: Math.max(0, Math.min(30_000, Math.floor(options.retry?.baseDelayMs ?? 250))),
      maxDelayMs: Math.max(0, Math.min(30_000, Math.floor(options.retry?.maxDelayMs ?? 30_000))),
    };
  }

  async request<T>(init: DkryptRequestInit): Promise<T> {
    const { path, ...request } = init;
    const response = await this.fetchWithRetry(this.buildUrl(path), {
      ...request,
      headers: this.createHeaders(request.headers, 'application/json'),
    }, this.canRetry(request));
    if (!response.ok) throw new Error(await this.responseError(response));
    return await response.json() as T;
  }

  async download(path: string, init: Pick<RequestInit, 'headers' | 'signal'> = {}): Promise<ArrayBuffer> {
    const response = await this.fetchWithRetry(this.buildUrl(path), {
      ...init,
      method: 'GET',
      headers: this.createHeaders(init.headers, 'application/octet-stream'),
    }, true);
    if (!response.ok) throw new Error(await this.responseError(response));
    return response.arrayBuffer();
  }

  async decrypt(bundleId: string, options: DkryptDecryptOptions = {}): Promise<DkryptJob> {
    const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
    const { version, signal } = options;
    return this.request<DkryptJob>({
      path: '/v1/decrypts',
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ bundleId, ...(version ? { version } : {}) }),
      signal,
    });
  }

  getJob(id: string, signal?: AbortSignal): Promise<DkryptJob> {
    return this.request<DkryptJob>({ path: \`/v1/jobs/\${encodeURIComponent(id)}\`, signal });
  }

  waitForJob(id: string, timeoutSeconds = 25, signal?: AbortSignal): Promise<DkryptJob> {
    const timeout = Math.max(1, Math.min(25, Math.floor(timeoutSeconds)));
    return this.request<DkryptJob>({ path: \`/v1/jobs/\${encodeURIComponent(id)}/wait?timeoutSeconds=\${timeout}\`, signal });
  }

  async *streamJobEvents(id: string, signal?: AbortSignal): AsyncGenerator<DkryptJobEventSnapshot> {
    let lastEventId: string | undefined;
    let reconnectDelayMs = 250;
    while (!signal?.aborted) {
      const headers = this.createHeaders(undefined, 'text/event-stream');
      if (lastEventId) headers.set('Last-Event-ID', lastEventId);
      let response: Response;
      try {
        response = await this.fetchWithRetry(this.buildUrl(\`/v1/jobs/\${encodeURIComponent(id)}/events\`), {
          method: 'GET',
          headers,
          signal,
        }, true);
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) return;
        await abortableDelay(reconnectDelayMs, signal ?? undefined);
        continue;
      }
      if (!response.ok) throw new Error(await this.responseError(response));
      if (!response.body) throw new Error('dkrypt job event stream has no response body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!signal?.aborted) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch {
            if (signal?.aborted) return;
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\\r\\n/g, '\\n');
          let separator = buffer.indexOf('\\n\\n');
          while (separator >= 0) {
            const block = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const parsed = parseSseBlock(block);
            if (parsed?.retryMs !== undefined) reconnectDelayMs = parsed.retryMs;
            if (parsed?.event === 'snapshot' && parsed.data) {
              const snapshot = JSON.parse(parsed.data) as DkryptJobEventSnapshot;
              if (parsed.id) lastEventId = parsed.id;
              yield snapshot;
              if (snapshot.job.status === 'done' || snapshot.job.status === 'failed') return;
            }
            separator = buffer.indexOf('\\n\\n');
          }
          if (chunk.done) break;
        }
      } finally {
        if (signal?.aborted) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (signal?.aborted) return;
      await abortableDelay(reconnectDelayMs, signal ?? undefined);
    }
  }

  async *followJob(id: string, signal?: AbortSignal): AsyncGenerator<DkryptJob> {
    for await (const update of this.streamJobEvents(id, signal)) yield update.job;
  }

  listArtifacts(options: { q?: string; limit?: number; cursor?: string; signal?: AbortSignal } = {}): Promise<DkryptArtifactPage> {
    const params = new URLSearchParams();
    if (options.q) params.set('q', options.q);
    params.set('limit', String(Math.max(1, Math.min(100, Math.floor(options.limit ?? 100)))));
    if (options.cursor) params.set('cursor', options.cursor);
    return this.request<DkryptArtifactPage>({ path: \`/v1/artifacts?\${params}\`, signal: options.signal });
  }

  async *iterateArtifacts(options: { q?: string; limit?: number; cursor?: string; signal?: AbortSignal } = {}): AsyncGenerator<DkryptArtifact> {
    let cursor = options.cursor;
    const seenCursors = new Set<string>();
    while (true) {
      const page = await this.listArtifacts({ ...options, cursor });
      yield* page.artifacts;
      if (!page.nextCursor) return;
      if (seenCursors.has(page.nextCursor)) throw new Error('dkrypt artifact pagination returned a repeated cursor');
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  async listAllArtifacts(options: { q?: string; limit?: number; cursor?: string; signal?: AbortSignal } = {}): Promise<DkryptArtifact[]> {
    const artifacts: DkryptArtifact[] = [];
    for await (const artifact of this.iterateArtifacts(options)) artifacts.push(artifact);
    return artifacts;
  }

  downloadArtifact(id: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.download(\`/v1/artifacts/\${encodeURIComponent(id)}/file\`, { signal });
  }

  private createHeaders(headers: RequestInit['headers'] | undefined, accept: string): Headers {
    const result = new Headers(headers);
    if (this.apiKey && !result.has('authorization')) result.set('Authorization', \`Bearer \${this.apiKey}\`);
    if (!result.has('accept')) result.set('Accept', accept);
    return result;
  }

  private canRetry(request: RequestInit): boolean {
    const method = (request.method ?? 'GET').toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
    return new Headers(request.headers).has('Idempotency-Key');
  }

  private async fetchWithRetry(url: URL, request: RequestInit, retryable: boolean): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, request);
      } catch (error) {
        if (!retryable || attempt + 1 >= this.retryOptions.maxAttempts || request.signal?.aborted || isAbortError(error)) throw error;
        await abortableDelay(this.retryDelay(attempt), request.signal ?? undefined);
        continue;
      }
      if (!retryable || attempt + 1 >= this.retryOptions.maxAttempts || ![429, 502, 503, 504].includes(response.status)) return response;
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
      await response.body?.cancel().catch(() => {});
      await abortableDelay(retryAfter ?? this.retryDelay(attempt), request.signal ?? undefined);
    }
  }

  private retryDelay(attempt: number): number {
    return Math.min(this.retryOptions.maxDelayMs, this.retryOptions.baseDelayMs * 2 ** attempt);
  }

  private buildUrl(path: string): URL {
    const baseUrl = new URL(this.baseUrl);
    const url = new URL(path, baseUrl);
    const allowsHttp = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname.toLowerCase());
    if (!['http:', 'https:'].includes(baseUrl.protocol) || !['http:', 'https:'].includes(url.protocol) || ((baseUrl.protocol === 'http:' || url.protocol === 'http:') && !allowsHttp)) {
      throw new Error('Use an HTTPS dkrypt URL; HTTP is allowed only for localhost');
    }
    if (url.origin !== baseUrl.origin) throw new Error('dkrypt requests must use the configured origin');
    return url;
  }

  private async responseError(response: Response): Promise<string> {
    const body: unknown = await response.json().catch(() => undefined);
    let detail: string | undefined;
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const errorBody = body as Record<string, unknown>;
      if (typeof errorBody.message === 'string') detail = errorBody.message;
      else if (typeof errorBody.error === 'string') detail = errorBody.error;
    }
    return detail ?? \`dkrypt request failed with HTTP \${response.status}\`;
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && (error as { name?: unknown }).name === 'AbortError';
}

function parseSseBlock(block: string): { id?: string; event?: string; data?: string; retryMs?: number } | undefined {
  let id: string | undefined;
  let event: string | undefined;
  let retryMs: number | undefined;
  const data: string[] = [];
  for (const line of block.split('\\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'id' && !value.includes('\\0')) id = value;
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
    if (field === 'retry' && /^\\d+$/.test(value)) retryMs = Math.min(30_000, Number(value));
  }
  return data.length > 0 || retryMs !== undefined ? { id, event, data: data.length ? data.join('\\n') : undefined, retryMs } : undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(30_000, Math.max(0, timestamp - Date.now())) : undefined;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
`;
}

function renderPython(routes: string[]): string {
  const routeValues = routes.map((route) => `    ${JSON.stringify(route)},`).join('\n');
  return `from __future__ import annotations

import json
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.parse import SplitResult, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROUTES = (
${routeValues}
)

@dataclass
class DkryptClient:
    base_url: str
    api_key: str | None = None
    retry_attempts: int = 3
    retry_base_delay: float = 0.25
    retry_max_delay: float = 30.0

    def request(self, method: str, path: str, body: object | None = None) -> object:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        response = self._send(method, path, payload, "application/json")
        return json.loads(response.decode("utf-8"))

    def download(self, path: str) -> bytes:
        return self._send("GET", path, None, "application/octet-stream")

    def decrypt(self, bundle_id: str, version: str | None = None, idempotency_key: str | None = None) -> object:
        from uuid import uuid4
        headers = {"Idempotency-Key": idempotency_key or str(uuid4())}
        body = {"bundleId": bundle_id}
        if version:
            body["version"] = version
        payload = json.dumps(body).encode("utf-8")
        return json.loads(self._send("POST", "/v1/decrypts", payload, "application/json", headers).decode("utf-8"))

    def get_job(self, job_id: str) -> object:
        from urllib.parse import quote
        return self.request("GET", f"/v1/jobs/{quote(job_id, safe='')}")

    def wait_for_job(self, job_id: str, timeout_seconds: int = 25) -> object:
        from urllib.parse import quote
        from urllib.parse import urlencode
        timeout = max(1, min(25, int(timeout_seconds)))
        return self.request("GET", f"/v1/jobs/{quote(job_id, safe='')}/wait?{urlencode({'timeoutSeconds': timeout})}")

    def iter_job_events(self, job_id: str):
        from urllib.parse import quote
        last_event_id = None
        reconnect_delay_seconds = 0.25
        while True:
            headers = {"Accept": "text/event-stream"}
            if last_event_id:
                headers["Last-Event-ID"] = last_event_id
            url = self._build_url(f"/v1/jobs/{quote(job_id, safe='')}/events")
            attempts = max(1, min(5, int(self.retry_attempts)))
            for attempt in range(attempts):
                request = Request(url, headers=headers, method="GET")
                if self.api_key:
                    request.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
                try:
                    handler = DkryptRedirectHandler(self._origin(urlsplit(self.base_url)), self.api_key)
                    with build_opener(handler).open(request, timeout=35) as response:
                        current = {"event": "message", "id": None, "data": []}
                        for raw_line in response:
                            line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else raw_line
                            line = line.rstrip("\\r\\n")
                            if not line:
                                if current["event"] == "snapshot" and current["data"]:
                                    snapshot = json.loads("\\n".join(current["data"]))
                                    if current["id"]:
                                        last_event_id = current["id"]
                                    yield snapshot
                                    job = snapshot.get("job", {}) if isinstance(snapshot, dict) else {}
                                    if isinstance(job, dict) and job.get("status") in ("done", "failed"):
                                        return
                                current = {"event": "message", "id": None, "data": []}
                                continue
                            if line.startswith(":"):
                                continue
                            field, separator, value = line.partition(":")
                            if separator and value.startswith(" "):
                                value = value[1:]
                            if field == "event":
                                current["event"] = value
                            elif field == "id" and "\\0" not in value:
                                current["id"] = value
                            elif field == "data":
                                current["data"].append(value)
                            elif field == "retry" and value.isdecimal():
                                reconnect_delay_seconds = min(30.0, int(value) / 1000)
                    break
                except HTTPError as error:
                    if attempt + 1 < attempts and error.code in (429, 502, 503, 504):
                        delay = self._retry_after(error.headers.get("Retry-After"))
                        error.close()
                        sleep(self._retry_delay(attempt) if delay is None else delay)
                        continue
                    detail = error.read().decode("utf-8", errors="replace")
                    raise RuntimeError(f"dkrypt request failed with HTTP {error.code}: {detail}") from error
                except URLError:
                    if attempt + 1 >= attempts:
                        break
                    sleep(self._retry_delay(attempt))
            sleep(reconnect_delay_seconds)

    def follow_job(self, job_id: str):
        for snapshot in self.iter_job_events(job_id):
            if isinstance(snapshot, dict) and isinstance(snapshot.get("job"), dict):
                yield snapshot["job"]

    def list_artifacts(self, query: str | None = None, limit: int = 100, cursor: str | None = None) -> object:
        from urllib.parse import urlencode
        params = {"limit": max(1, min(100, int(limit)))}
        if query:
            params["q"] = query
        if cursor:
            params["cursor"] = cursor
        return self.request("GET", f"/v1/artifacts?{urlencode(params)}")

    def iter_artifacts(self, query: str | None = None, limit: int = 100, cursor: str | None = None):
        seen_cursors = set()
        while True:
            page = self.list_artifacts(query, limit, cursor)
            if not isinstance(page, dict):
                raise RuntimeError("dkrypt artifact page has an invalid response")
            yield from page.get("artifacts", [])
            next_cursor = page.get("nextCursor")
            if not next_cursor:
                return
            if next_cursor in seen_cursors:
                raise RuntimeError("dkrypt artifact pagination returned a repeated cursor")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

    def list_all_artifacts(self, query: str | None = None, limit: int = 100, cursor: str | None = None) -> list[object]:
        return list(self.iter_artifacts(query, limit, cursor))

    def download_artifact(self, artifact_id: str) -> bytes:
        from urllib.parse import quote
        return self.download(f"/v1/artifacts/{quote(artifact_id, safe='')}/file")

    def _send(self, method: str, path: str, payload: bytes | None, accept: str, extra_headers: dict[str, str] | None = None) -> bytes:
        headers = {"Accept": accept}
        headers.update(extra_headers or {})
        if payload is not None:
            headers["Content-Type"] = "application/json"
        url = self._build_url(path)
        normalized_method = method.upper()
        safe_to_retry = normalized_method in ("GET", "HEAD", "OPTIONS") or any(name.lower() == "idempotency-key" for name in headers)
        attempts = max(1, min(5, int(self.retry_attempts))) if safe_to_retry else 1
        for attempt in range(attempts):
            request = Request(url, data=payload, headers=headers, method=normalized_method)
            if self.api_key:
                request.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
            try:
                redirect_handler = DkryptRedirectHandler(self._origin(urlsplit(self.base_url)), self.api_key)
                with build_opener(redirect_handler).open(request) as response:
                    return response.read()
            except HTTPError as error:
                if attempt + 1 < attempts and error.code in (429, 502, 503, 504):
                    delay = self._retry_after(error.headers.get("Retry-After"))
                    error.close()
                    sleep(self._retry_delay(attempt) if delay is None else delay)
                    continue
                detail = error.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"dkrypt request failed with HTTP {error.code}: {detail}") from error
            except URLError:
                if attempt + 1 >= attempts:
                    raise
                sleep(self._retry_delay(attempt))
        raise RuntimeError("dkrypt request could not be completed")

    def _retry_delay(self, attempt: int) -> float:
        return min(max(0.0, self.retry_max_delay), max(0.0, self.retry_base_delay) * (2 ** attempt))

    def _retry_after(self, value: str | None) -> float | None:
        if value is None:
            return None
        try:
            return min(30.0, max(0.0, float(value)))
        except ValueError:
            try:
                from datetime import datetime, timezone
                return min(30.0, max(0.0, (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()))
            except (TypeError, ValueError, OverflowError):
                return None

    def _build_url(self, path: str) -> str:
        base_url = self.base_url.rstrip("/") + "/"
        request_url = urljoin(base_url, path)
        base = urlsplit(base_url)
        target = urlsplit(request_url)
        if (
            target.scheme.lower() not in ("http", "https")
            or (target.scheme.lower() == "http" and target.hostname not in ("localhost", "127.0.0.1", "::1"))
            or target.username is not None
            or target.password is not None
            or self._origin(base) != self._origin(target)
        ):
            raise ValueError("dkrypt requests must use the configured origin over HTTPS except on localhost")
        return request_url

    @staticmethod
    def _origin(url: SplitResult) -> tuple[str, str | None, int]:
        scheme = url.scheme.lower()
        default_port = 443 if scheme == "https" else 80
        port = url.port
        return scheme, url.hostname, default_port if port is None else port

class DkryptRedirectHandler(HTTPRedirectHandler):
    def __init__(self, origin: tuple[str, str | None, int], api_key: str | None):
        super().__init__()
        self.origin = origin
        self.api_key = api_key

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        target = urlsplit(newurl)
        if (
            redirected is not None
            and self.api_key
            and target.username is None
            and target.password is None
            and DkryptClient._origin(target) == self.origin
        ):
            redirected.add_unredirected_header("Authorization", f"Bearer {self.api_key}")
        return redirected
`;
}
