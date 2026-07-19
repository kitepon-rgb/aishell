import Foundation

public struct AllowedPathResolver: Sendable {
    public let rootURL: URL

    public init(rootPath: String) throws {
        let rootURL = URL(fileURLWithPath: rootPath, isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: rootURL.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            throw AIShellError.invalidPath(rootPath)
        }

        self.rootURL = rootURL
    }

    public func resolveExisting(_ path: String?) throws -> URL {
        let candidate = rawURL(for: path)
        guard FileManager.default.fileExists(atPath: candidate.path) else {
            throw AIShellError.itemNotFound(candidate.path)
        }

        let resolved = candidate.resolvingSymlinksInPath().standardizedFileURL
        try ensureContained(resolved)
        return resolved
    }

    public func resolveDestination(_ path: String) throws -> URL {
        guard !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AIShellError.invalidPath(path)
        }

        let candidate = rawURL(for: path)
        var ancestor = candidate
        var missingComponents: [String] = []

        while !FileManager.default.fileExists(atPath: ancestor.path) {
            let parent = ancestor.deletingLastPathComponent()
            guard parent.path != ancestor.path else {
                throw AIShellError.invalidPath(path)
            }
            missingComponents.insert(ancestor.lastPathComponent, at: 0)
            ancestor = parent
        }

        var resolved = ancestor.resolvingSymlinksInPath().standardizedFileURL
        for component in missingComponents {
            resolved.appendPathComponent(component)
        }
        resolved = resolved.standardizedFileURL

        try ensureContained(resolved)
        return resolved
    }

    private func rawURL(for path: String?) -> URL {
        guard let path, !path.isEmpty else {
            return rootURL
        }

        if path.hasPrefix("/") {
            return URL(fileURLWithPath: path).standardizedFileURL
        }

        return rootURL.appendingPathComponent(path).standardizedFileURL
    }

    private func ensureContained(_ url: URL) throws {
        let rootComponents = rootURL.pathComponents
        let targetComponents = url.pathComponents
        guard targetComponents.count >= rootComponents.count,
              Array(targetComponents.prefix(rootComponents.count)) == rootComponents else {
            throw AIShellError.outsideAllowedRoot(url.path)
        }
    }
}
