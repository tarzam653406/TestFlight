import Foundation
import Security

enum APIError: LocalizedError {
    case notConfigured
    case unauthorized
    case server(Int, String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: "Add your server URL and app token in Settings."
        case .unauthorized: "The app token was rejected. Check it in Settings."
        case let .server(code, message): "Server error \(code): \(message)"
        }
    }
}

/// Talks to the Daily Goals server. The server URL lives in UserDefaults and the
/// app token in the Keychain.
struct APIClient {
    static let shared = APIClient()

    var baseURL: URL? {
        guard let raw = UserDefaults.standard.string(forKey: "serverURL"), !raw.isEmpty else { return nil }
        return URL(string: raw.hasSuffix("/") ? String(raw.dropLast()) : raw)
    }

    var token: String? { Keychain.read("appToken") }

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    func agenda(date: String?) async throws -> Agenda {
        let query = date.map { "?date=\($0)" } ?? ""
        return try await request("GET", "/api/agenda\(query)")
    }

    func setDone(_ id: String, _ done: Bool) async throws -> GoalTask {
        try await request("PATCH", "/api/tasks/\(id)", body: ["done": done])
    }

    func updateTask(_ id: String, patch: [String: Any?]) async throws -> GoalTask {
        try await request("PATCH", "/api/tasks/\(id)", json: patch)
    }

    func createTask(title: String, horizon: Horizon, date: String) async throws -> GoalTask {
        try await request("POST", "/api/tasks", body: ["title": title, "horizon": horizon.rawValue, "date": date])
    }

    func deleteTask(_ id: String) async throws {
        let _: Empty = try await request("DELETE", "/api/tasks/\(id)")
    }

    func capture(_ item: QueuedCapture) async throws -> CaptureResult {
        struct Body: Encodable { let text: String; let capturedAt: Date }
        return try await request("POST", "/api/captures", body: Body(text: item.text, capturedAt: item.capturedAt))
    }

    func syncNow() async throws {
        let _: Empty = try await request("POST", "/api/sync")
    }

    // MARK: - plumbing

    private struct Empty: Decodable {}

    private func request<T: Decodable>(_ method: String, _ path: String, body: some Encodable) async throws -> T {
        try await send(method, path, data: try encoder.encode(body))
    }

    private func request<T: Decodable>(_ method: String, _ path: String, json: [String: Any?]) async throws -> T {
        let cleaned = json.mapValues { $0 ?? NSNull() }
        return try await send(method, path, data: try JSONSerialization.data(withJSONObject: cleaned))
    }

    private func request<T: Decodable>(_ method: String, _ path: String) async throws -> T {
        try await send(method, path, data: nil)
    }

    private func send<T: Decodable>(_ method: String, _ path: String, data: Data?) async throws -> T {
        guard let baseURL, let token, let url = URL(string: baseURL.absoluteString + path) else {
            throw APIError.notConfigured
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 90 // planning a long thought can take a while
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let data {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = data
        }
        let (body, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode([String: String].self, from: body))?["error"] ?? "request failed"
            throw APIError.server(status, message)
        }
        if body.isEmpty || status == 204, let empty = Empty() as? T { return empty }
        return try JSONDecoder().decode(T.self, from: body)
    }
}

enum Keychain {
    private static let service = "DailyGoals"

    static func read(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ key: String, _ value: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        // Readable after first unlock so Siri can capture while the phone is locked.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}
