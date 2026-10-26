import Foundation

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
    public let versionLabel: String?
    public let fileSizeBytes: Int64?
}

public struct DkryptArtifactPage: Decodable, Sendable {
    public let artifacts: [DkryptArtifact]
    public let nextCursor: String?
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

    public func decrypt(bundleId: String, version: String? = nil, idempotencyKey: String = UUID().uuidString) async throws -> DkryptJob {
        var body: [String: String] = ["bundleId": bundleId]
        if let version { body["version"] = version }
        return try await request("/v1/decrypts", method: "POST", body: body, idempotencyKey: idempotencyKey)
    }

    public func getJob(id: String) async throws -> DkryptJob {
        try await request("/v1/jobs/" + Self.pathComponent(id))
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
        try await requestData("/v1/artifacts/" + Self.pathComponent(id) + "/file")
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: String]? = nil, idempotencyKey: String? = nil) async throws -> T {
        let data = try await requestData(path, method: method, body: body, idempotencyKey: idempotencyKey)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func requestData(_ path: String, method: String = "GET", body: [String: String]? = nil, idempotencyKey: String? = nil) async throws -> Data {
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
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let apiKey { request.setValue("Bearer " + apiKey, forHTTPHeaderField: "Authorization") }
        if let body { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONEncoder().encode(body) }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(response.statusCode) else { throw NSError(domain: "DkryptClient", code: response.statusCode, userInfo: [NSLocalizedDescriptionKey: String(decoding: data, as: UTF8.self)]) }
        return data
    }

    private static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
    }
}
