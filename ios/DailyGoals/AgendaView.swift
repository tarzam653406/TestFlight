import SwiftUI

struct AgendaView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false
    @State private var editing: GoalTask?

    var body: some View {
        NavigationStack {
            List {
                Section { CaptureCard() }

                if let error = model.errorMessage {
                    Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                }

                if let agenda = model.agenda {
                    if agenda.date == agenda.today, !agenda.overdue.isEmpty {
                        taskSection("Carried over", tasks: agenda.overdue, horizon: nil, showDate: true)
                    }
                    taskSection(agenda.date == agenda.today ? "Today" : ISODay.pretty(agenda.date), tasks: agenda.day, horizon: .day)
                    taskSection("Week of \(shortDate(agenda.periods.week))", tasks: agenda.week, horizon: .week)
                    taskSection(monthName(agenda.periods.month), tasks: agenda.month, horizon: .month)
                    taskSection(String(agenda.periods.year.prefix(4)), tasks: agenda.year, horizon: .year)
                    if !agenda.someday.isEmpty {
                        taskSection("Someday", tasks: agenda.someday, horizon: .someday)
                    }
                } else if !model.isConfigured {
                    Section {
                        Button("Connect to your server") { showSettings = true }
                    } footer: {
                        Text("Enter the server URL and APP_TOKEN from your Daily Goals server.")
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .refreshable {
                await model.syncNow()
            }
            .toolbar {
                ToolbarItemGroup(placement: .topBarLeading) {
                    Button { Task { await model.shiftDay(-1) } } label: { Image(systemName: "chevron.left") }
                    Button { Task { await model.shiftDay(1) } } label: { Image(systemName: "chevron.right") }
                    if let agenda = model.agenda, agenda.date != agenda.today {
                        Button("Today") { Task { await model.goToToday() } }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
            }
            .sheet(isPresented: $showSettings, onDismiss: { Task { await model.refresh() } }) {
                SettingsView()
            }
            .sheet(item: $editing) { task in
                TaskEditor(task: task)
            }
            .task {
                if !model.isConfigured { showSettings = true }
                await model.flushQueue()
                await model.refresh()
            }
        }
    }

    private var title: String {
        guard let agenda = model.agenda else { return "Daily Goals" }
        return ISODay.pretty(agenda.date)
    }

    @ViewBuilder
    private func taskSection(_ header: String, tasks: [GoalTask], horizon: Horizon?, showDate: Bool = false) -> some View {
        Section {
            ForEach(tasks) { task in
                TaskRow(task: task, showDate: showDate)
                    .contentShape(Rectangle())
                    .onTapGesture { editing = task }
                    .swipeActions(edge: .leading) {
                        Button { Task { await model.toggle(task) } } label: {
                            Label(task.done ? "Undo" : "Done", systemImage: task.done ? "arrow.uturn.backward" : "checkmark")
                        }
                        .tint(.green)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { Task { await model.delete(task) } } label: { Label("Delete", systemImage: "trash") }
                        Button { Task { await model.moveToTomorrow(task) } } label: { Label("Tomorrow", systemImage: "arrow.right.circle") }
                            .tint(.blue)
                    }
            }
            if let horizon {
                AddTaskRow(horizon: horizon)
            }
        } header: {
            HStack {
                Text(header)
                Spacer()
                if !tasks.isEmpty {
                    Text("\(tasks.filter(\.done).count)/\(tasks.count)")
                }
            }
        }
    }

    private func shortDate(_ day: String) -> String {
        ISODay.date(day)?.formatted(.dateTime.month(.abbreviated).day()) ?? day
    }

    private func monthName(_ day: String) -> String {
        ISODay.date(day)?.formatted(.dateTime.month(.wide).year()) ?? day
    }
}

struct TaskRow: View {
    @Environment(AppModel.self) private var model
    let task: GoalTask
    var showDate = false

    var body: some View {
        HStack(spacing: 12) {
            Button {
                Task { await model.toggle(task) }
            } label: {
                Image(systemName: task.done ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(task.done ? Color.accentColor : Color.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(task.done ? "Mark not done" : "Mark done")

            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .strikethrough(task.done)
                    .foregroundStyle(task.done ? .secondary : .primary)
                if !task.notes.isEmpty {
                    Text(task.notes).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                if let time = task.startTime { Text(time).font(.caption).foregroundStyle(.secondary) }
                if showDate, let day = task.periodStart { Text(day).font(.caption2).foregroundStyle(.orange) }
                HStack(spacing: 4) {
                    if task.source == "google-calendar" || task.linkedTo.contains("google-calendar") {
                        Image(systemName: "calendar")
                    }
                    if task.source == "trello" || task.linkedTo.contains("trello") {
                        Image(systemName: "rectangle.split.3x1") // Planyway / Trello
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
        }
    }
}

struct AddTaskRow: View {
    @Environment(AppModel.self) private var model
    let horizon: Horizon
    @State private var title = ""

    var body: some View {
        TextField("Add a task", text: $title)
            .submitLabel(.done)
            .onSubmit {
                let text = title
                title = ""
                Task { await model.add(title: text, horizon: horizon) }
            }
    }
}

struct TaskEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let task: GoalTask

    @State private var title = ""
    @State private var notes = ""
    @State private var horizon: Horizon = .day
    @State private var date = Date()
    @State private var hasTime = false
    @State private var time = Date()

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title)
                TextField("Notes", text: $notes, axis: .vertical)
                Picker("When", selection: $horizon) {
                    ForEach(Horizon.allCases) { Text($0.label).tag($0) }
                }
                if horizon != .someday {
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                }
                if horizon == .day {
                    Toggle("At a set time", isOn: $hasTime)
                    if hasTime {
                        DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                    }
                }
            }
            .navigationTitle("Edit task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            await model.update(task, patch: patch)
                            dismiss()
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear(perform: load)
        }
    }

    private var patch: [String: Any?] {
        var p: [String: Any?] = ["title": title, "notes": notes, "horizon": horizon.rawValue]
        if horizon != .someday { p["date"] = ISODay.string(date) }
        // updateValue keeps an explicit nil (clears the time); `p[key] = nil` would drop the key.
        let start: String? = horizon == .day && hasTime ? Self.timeFormatter.string(from: time) : nil
        p.updateValue(start, forKey: "startTime")
        return p
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f
    }()

    private func load() {
        title = task.title
        notes = task.notes
        horizon = task.horizon
        date = task.periodStart.flatMap(ISODay.date) ?? model.agenda.flatMap { ISODay.date($0.date) } ?? Date()
        if let start = task.startTime {
            let parts = start.split(separator: ":").compactMap { Int($0) }
            if parts.count == 2, let t = Calendar.current.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: Date()) {
                hasTime = true
                time = t
            }
        }
    }
}
