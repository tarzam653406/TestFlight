import SwiftUI

/// The "brain dump" box at the top of the agenda: type or dictate, then let Claude sort it.
struct CaptureCard: View {
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var dictation = Dictation()
    @State private var textBeforeDictation = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("What's on your mind?", text: $text, axis: .vertical)
                .lineLimit(3...8)
                .focused($focused)

            HStack {
                Button {
                    if !dictation.isListening {
                        textBeforeDictation = text.isEmpty ? "" : text + " "
                    }
                    Task { await dictation.toggle() }
                } label: {
                    Image(systemName: dictation.isListening ? "stop.circle.fill" : "mic.circle")
                        .font(.title2)
                        .foregroundStyle(dictation.isListening ? Color.red : Color.accentColor)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(dictation.isListening ? "Stop dictation" : "Dictate")

                if dictation.isListening {
                    Text("Listening…").font(.caption).foregroundStyle(.secondary)
                } else if model.queuedCount > 0 {
                    Text("\(model.queuedCount) waiting to send").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if model.isProcessing {
                    ProgressView()
                } else {
                    Button("Process") {
                        dictation.stop()
                        let thought = text
                        Task {
                            if await model.capture(thought) {
                                text = ""
                                focused = false
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }

            if let error = dictation.errorMessage {
                Text(error).font(.caption).foregroundStyle(.orange)
            }

            if let result = model.lastResult {
                VStack(alignment: .leading, spacing: 4) {
                    Text(result.summary).font(.callout)
                    ForEach(Array(result.applied.enumerated()), id: \.offset) { _, op in
                        Text(describe(op)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .onChange(of: dictation.transcript) { _, spoken in
            if !spoken.isEmpty { text = textBeforeDictation + spoken }
        }
    }

    private func describe(_ op: AppliedOperation) -> String {
        if let skipped = op.skipped { return "Skipped \(op.title) (\(skipped))" }
        let verb = ["create": "Added", "complete": "Checked off", "reopen": "Reopened", "reschedule": "Moved", "update": "Updated"][op.action] ?? op.action
        let when = op.periodStart.map { "\(op.horizon.rawValue) of \($0)" } ?? op.horizon.rawValue
        return "\(verb) \(op.title) → \(when)"
    }
}
