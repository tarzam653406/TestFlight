import Foundation
import Observation

/// Thoughts captured while offline (from the app or from Siri), sent when the server is reachable.
enum OfflineQueue {
    private static let key = "captureQueue"

    static func load() -> [QueuedCapture] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([QueuedCapture].self, from: data)) ?? []
    }

    static func save(_ items: [QueuedCapture]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(items), forKey: key)
    }

    static func append(_ item: QueuedCapture) {
        save(load() + [item])
    }
}

@MainActor
@Observable
final class AppModel {
    var agenda: Agenda?
    /// nil means "today" as the server sees it.
    var selectedDate: String?
    var errorMessage: String?
    var lastResult: CaptureResult?
    var isProcessing = false
    var queuedCount = OfflineQueue.load().count

    private let api = APIClient.shared

    var isConfigured: Bool { api.baseURL != nil && api.token != nil }

    func refresh() async {
        guard isConfigured else { return }
        do {
            agenda = try await api.agenda(date: selectedDate)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func shiftDay(_ delta: Int) async {
        guard let current = agenda?.date else { return }
        selectedDate = ISODay.shift(current, by: delta)
        await refresh()
    }

    func goToToday() async {
        selectedDate = nil
        await refresh()
    }

    func toggle(_ task: GoalTask) async {
        await perform { _ = try await self.api.setDone(task.id, !task.done) }
    }

    func add(title: String, horizon: Horizon) async {
        guard let date = agenda?.date else { return }
        await perform { _ = try await self.api.createTask(title: title, horizon: horizon, date: date) }
    }

    func update(_ task: GoalTask, patch: [String: Any?]) async {
        await perform { _ = try await self.api.updateTask(task.id, patch: patch) }
    }

    func delete(_ task: GoalTask) async {
        await perform { try await self.api.deleteTask(task.id) }
    }

    func moveToTomorrow(_ task: GoalTask) async {
        guard let today = agenda?.today else { return }
        await update(task, patch: ["horizon": "day", "date": ISODay.shift(today, by: 1)])
    }

    /// Returns true when the thought was processed or queued (so the caller can clear its input).
    func capture(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let item = QueuedCapture(text: trimmed, capturedAt: .now)
        isProcessing = true
        defer { isProcessing = false }
        do {
            lastResult = try await api.capture(item)
            errorMessage = nil
            await refresh()
            return true
        } catch is URLError {
            OfflineQueue.append(item)
            queuedCount = OfflineQueue.load().count
            errorMessage = "You're offline. The thought is saved and will be processed later."
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func flushQueue() async {
        let queue = OfflineQueue.load()
        guard !queue.isEmpty, isConfigured else { return }
        var remaining: [QueuedCapture] = []
        for item in queue {
            do {
                lastResult = try await api.capture(item)
            } catch is URLError {
                remaining.append(item)
            } catch {
                // The server keeps failed thoughts in its capture log; don't retry forever.
                errorMessage = error.localizedDescription
            }
        }
        OfflineQueue.save(remaining)
        queuedCount = remaining.count
        await refresh()
    }

    func syncNow() async {
        await perform { try await self.api.syncNow() }
    }

    private func perform(_ work: @escaping () async throws -> Void) async {
        do {
            try await work()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        await refresh()
    }
}
