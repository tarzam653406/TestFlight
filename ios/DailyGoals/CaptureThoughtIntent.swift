import AppIntents

/// "Hey Siri, capture a thought in Daily Goals" — also usable from Shortcuts,
/// the Action button, and Back Tap.
struct CaptureThoughtIntent: AppIntent {
    static var title: LocalizedStringResource = "Capture Thought"
    static var description = IntentDescription("Send a thought to Daily Goals so it can update your to-do lists.")

    @Parameter(title: "Thought", requestValueDialog: "What's on your mind?")
    var text: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let item = QueuedCapture(text: text, capturedAt: .now)
        do {
            let result = try await APIClient.shared.capture(item)
            return .result(dialog: "\(result.summary)")
        } catch is URLError {
            OfflineQueue.append(item)
            return .result(dialog: "You're offline, so I saved that and will process it later.")
        }
    }
}

struct DailyGoalsShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CaptureThoughtIntent(),
            phrases: [
                "Capture a thought in \(.applicationName)",
                "Add to \(.applicationName)",
                "Tell \(.applicationName) something",
            ],
            shortTitle: "Capture Thought",
            systemImageName: "brain.head.profile"
        )
    }
}
