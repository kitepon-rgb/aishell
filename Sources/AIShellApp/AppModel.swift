import AIShellCore
import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var configuration = RuntimeConfiguration()
    @Published private(set) var activities: [OperationRecord] = []
    @Published var errorMessage: String?

    private let store = RuntimeStore()

    var rootDisplayName: String {
        guard let path = configuration.allowedRootPath else {
            return "未選択"
        }
        return URL(fileURLWithPath: path).lastPathComponent
    }

    var rootPath: String {
        configuration.allowedRootPath ?? "AIShellが操作するフォルダを選択してください"
    }

    var isReady: Bool {
        configuration.allowedRootPath != nil && !configuration.isPaused
    }

    func chooseRoot() {
        let panel = NSOpenPanel()
        panel.title = "AIに操作を許可するフォルダを選択"
        panel.message = "AIShellは選択したフォルダと、その内側だけを操作します。"
        panel.prompt = "このフォルダを許可"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true

        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do {
                configuration = try await store.setAllowedRoot(url)
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
