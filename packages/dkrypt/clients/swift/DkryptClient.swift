import Foundation
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
            job = try await request("/v1/jobs/\(Self.pathComponent(id))/wait?timeoutSeconds=\(waitSeconds)")
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
        let data = try await requestData(artifact.fileUrl ?? "/v1/artifacts/\(Self.pathComponent(id))/file")
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
        let path = artifact.fileUrl ?? "/v1/artifacts/\(Self.pathComponent(id))/file"
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
        let staging = directory.appendingPathComponent(".\(destination.lastPathComponent).\(UUID().uuidString).partial")
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
