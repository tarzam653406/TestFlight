import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @AppStorage("serverURL") private var serverURL = ""
    @State private var token = Keychain.read("appToken") ?? ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://goals.example.com", text: $serverURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("App token", text: $token)
                } header: {
                    Text("Server")
                } footer: {
                    Text("Use the PUBLIC_URL and APP_TOKEN from the server's .env file.")
                }

                Section {
                    Button("Sync now") { Task { await model.syncNow() } }
                    if let url = URL(string: serverURL), !serverURL.isEmpty {
                        Link("Connect Google Calendar (opens web app)", destination: url)
                    }
                } footer: {
                    Text("Google Calendar is connected once from the web app's settings; after that the server syncs it for every device.")
                }

                Section {
                    Text("Say “Hey Siri, capture a thought in Daily Goals”, or add the Capture Thought action to the Action button or Back Tap.")
                        .font(.callout)
                } header: {
                    Text("Capture on the go")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        Keychain.write("appToken", token.trimmingCharacters(in: .whitespacesAndNewlines))
                        dismiss()
                    }
                }
            }
        }
    }
}
