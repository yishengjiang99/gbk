import SwiftUI

/// Report (`POST /api/reports`, live) and block (`POST /api/blocks/:handle`, P4: reports "not available" on 404).
struct ReportBlockSheet: View {
    /// "comment" | "message" | "song" | "user"
    let kind: String
    let target: String
    let author: String
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var status: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                if auth.isSignedIn {
                    Section("Report this \(kind)") {
                        TextField("What's wrong?", text: $reason, axis: .vertical).lineLimit(2...6)
                        Button("Send report") { Task { await report() } }
                            .disabled(busy || reason.trimmingCharacters(in: .whitespaces).isEmpty || reason.count > 500)
                    }
                    Section {
                        Button("Block @\(author)", role: .destructive) { Task { await block() } }.disabled(busy)
                    } footer: { Text("Blocking hides their comments and messages for you.") }
                } else {
                    SignInView(reason: "Sign in to report or block.")
                }
                if let status { Section { Text(status) } }
            }
            .navigationTitle("Report or block")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }

    private func report() async {
        busy = true; defer { busy = false }
        do {
            _ = try await APIClient.shared.send(Endpoints.report(kind: kind, target: target, reason: reason), as: ReportResult.self)
            status = "Thanks. We'll review it."
            reason = ""
        } catch let e as APIError { status = e.userMessage } catch { status = "Couldn't send the report." }
    }

    private func block() async {
        busy = true; defer { busy = false }
        do {
            if try await APIClient.shared.sendIfAvailable(Endpoints.block(author), as: OKResult.self) != nil {
                status = "Blocked @\(author)."
            } else {
                status = "Blocking isn't available yet. Your report still helps."
            }
        } catch let e as APIError { status = e.userMessage } catch { status = "Couldn't block." }
    }
}
