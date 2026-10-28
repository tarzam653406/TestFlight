import SwiftUI

@main
struct DailyGoalsApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            AgendaView()
                .environment(model)
                .onChange(of: scenePhase) { _, phase in
                    // Pick up changes synced from other apps, and send thoughts queued offline or via Siri.
                    if phase == .active {
                        Task {
                            await model.flushQueue()
                            await model.refresh()
                        }
                    }
                }
        }
    }
}
