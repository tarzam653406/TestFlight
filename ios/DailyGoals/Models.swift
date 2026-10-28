import Foundation

// Mirrors the server's JSON. Named GoalTask to avoid clashing with Swift's Task.
struct GoalTask: Codable, Identifiable, Hashable {
    let id: String
    var title: String
    var notes: String
    var horizon: Horizon
    var periodStart: String?
    var startTime: String?
    var durationMinutes: Int?
    var done: Bool
    var source: String
    var linkedTo: [String]
}

enum Horizon: String, Codable, CaseIterable, Identifiable {
    case day, week, month, year, someday
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

struct Periods: Codable, Hashable {
    let day: String
    let week: String
    let month: String
    let year: String
}

struct Agenda: Codable {
    let date: String
    let today: String
    let periods: Periods
    var day: [GoalTask]
    var week: [GoalTask]
    var month: [GoalTask]
    var year: [GoalTask]
    var someday: [GoalTask]
    var overdue: [GoalTask]
}

struct AppliedOperation: Codable, Hashable {
    let action: String
    let title: String
    let horizon: Horizon
    let periodStart: String?
    let taskId: String?
    let skipped: String?
    let reason: String
}

struct CaptureResult: Codable {
    let captureId: String
    let summary: String
    let applied: [AppliedOperation]
}

struct QueuedCapture: Codable, Hashable {
    let text: String
    let capturedAt: Date
}

enum ISODay {
    static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func string(_ date: Date) -> String { formatter.string(from: date) }
    static func date(_ string: String) -> Date? { formatter.date(from: string) }

    static func shift(_ day: String, by days: Int) -> String {
        guard let d = date(day), let shifted = Calendar.current.date(byAdding: .day, value: days, to: d) else { return day }
        return string(shifted)
    }

    static func pretty(_ day: String) -> String {
        guard let d = date(day) else { return day }
        return d.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }
}
