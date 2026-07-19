import Foundation

public struct AllowedPathResolver: Sendable {
    public let rootURLs: [URL]

    public var rootURL: URL {
        rootURLs[0]
    }

    public init(rootPath: String) throws {
        try self.init(rootPaths: [rootPath])
    }

    public init(rootPaths: [String]) throws {
        guard !rootPaths.isEmpty else {
            throw AIShellError.notConfigured
        }

        var roots: [URL] = []
        for rootPath in rootPaths {
            let rootURL = URL(fileURLWithPath: rootPath, isDirectory: true)
                .standardizedFileURL
                .resolvingSymlinksInPath()

            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: rootURL.path, isDirectory: &isDirectory),
                  isDirectory.boolValue else {
                throw AIShellError.invalidPath(rootPath)
            }

            if !roots.contains(rootURL) {
                roots.append(rootURL)
            }
        }

        rootURLs = roots
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

    public func isAllowedRoot(_ url: URL) -> Bool {
        let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
        return rootURLs.contains(canonical)
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
        guard rootURLs.contains(where: { contains(url, in: $0) }) else {
            throw AIShellError.outsideAllowedRoot(url.path)
        }
    }

    private func contains(_ target: URL, in root: URL) -> Bool {
        let rootComponents = root.pathComponents
        let targetComponents = target.pathComponents
        return targetComponents.count >= rootComponents.count
            && Array(targetComponents.prefix(rootComponents.count)) == rootComponents
    }
}
