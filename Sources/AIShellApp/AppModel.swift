import AIShellCore
import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var configuration = RuntimeConfiguration()
    @Published private(set) var activities: [OperationRecord] = []
    @Published var errorMessage: String?

    private let store = RuntimeStore()

    var isReady: Bool {
        !configuration.allowedRootPaths.isEmpty && !configuration.isPaused
    }

    func addRoots() {
        let panel = NSOpenPanel()
        panel.title = "AIに操作を許可するrootを追加"
        panel.message = "複数選択できます。AIShellは追加したrootと、その内側だけを操作します。"
        panel.prompt = "選択したrootを追加"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = true

        guard panel.runModal() == .OK, !panel.urls.isEmpty else { return }
        Task {
            do {
                configuration = try await store.addAllowedRoots(panel.urls)
                errorMessage = nil
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func removeRoot(_ path: String) {
        Task {
            do {
                configuration = try await store.removeAllowedRoot(path: path)
                errorMessage = nil
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func togglePaused() {
        Task {
            do {
                configuration = try await store.setPaused(!configuration.isPaused)
                errorMessage = nil
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func refresh() async {
        do {
            configuration = try await store.loadConfiguration()
            activities = try await store.loadRecentActivities(limit: 100)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(1))
        }
    }
}
