import Foundation

public struct AllowedPathResolver: Sendable {
    public let configuredRootURLs: [URL]
    public let gitWorktreeRootURLs: [URL]
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
        var requestedRoots: [URL] = []
        for rootPath in rootPaths {
            let requestedRoot = URL(fileURLWithPath: rootPath, isDirectory: true).standardizedFileURL
            let rootURL = requestedRoot.resolvingSymlinksInPath()
            requestedRoots.append(requestedRoot)

            if roots.contains(where: {
                ReservedNamespacePolicy.contains(url: rootURL, under: [$0])
            }) {
                throw AIShellError.reservedPath(rootURL.path)
            }

            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: rootURL.path, isDirectory: &isDirectory),
                  isDirectory.boolValue else {
                throw AIShellError.invalidPath(rootPath)
            }

            if !roots.contains(rootURL) {
                roots.append(rootURL)
            }
        }

        configuredRootURLs = roots
        gitWorktreeRootURLs = Self.discoverGitWorktreeRoots(for: roots)
        rootURLs = roots + gitWorktreeRootURLs.filter { !roots.contains($0) }
        for root in rootURLs {
            let otherRoots = rootURLs.filter { $0 != root }
            if ReservedNamespacePolicy.contains(url: root, under: otherRoots) {
                throw AIShellError.reservedPath(root.path)
            }
        }
        for requestedRoot in requestedRoots {
            if ReservedNamespacePolicy.contains(url: requestedRoot, under: rootURLs) {
                throw AIShellError.reservedPath(requestedRoot.path)
            }
        }
    }

    public func resolveExisting(_ path: String?) throws -> URL {
        let candidate = rawURL(for: path)
        try ReservedNamespacePolicy.requirePublicPath(candidate, under: rootURLs)
        guard FileManager.default.fileExists(atPath: candidate.path) else {
            throw AIShellError.itemNotFound(candidate.path)
        }

        let resolved = candidate.resolvingSymlinksInPath().standardizedFileURL
        try ensureContained(resolved)
        try ReservedNamespacePolicy.requirePublicPath(resolved, under: rootURLs)
        return resolved
    }

    public func resolveDestination(_ path: String) throws -> URL {
        guard !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AIShellError.invalidPath(path)
        }

        let candidate = rawURL(for: path)
        try ReservedNamespacePolicy.requirePublicPath(candidate, under: rootURLs)
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
        try ReservedNamespacePolicy.requirePublicPath(resolved, under: rootURLs)
        for component in missingComponents {
            resolved.appendPathComponent(component)
        }
        resolved = resolved.standardizedFileURL

        try ensureContained(resolved)
        try ReservedNamespacePolicy.requirePublicPath(resolved, under: rootURLs)
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

    private static func discoverGitWorktreeRoots(for roots: [URL]) -> [URL] {
        var discovered: [URL] = []
        for root in roots {
            guard let commonGitDirectory = commonGitDirectory(for: root) else { continue }
            let worktreesDirectory = commonGitDirectory.appendingPathComponent("worktrees", isDirectory: true)
            guard let administrativeDirectories = try? FileManager.default.contentsOfDirectory(
                at: worktreesDirectory,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) else { continue }

            for administrativeDirectory in administrativeDirectories {
                guard let values = try? administrativeDirectory.resourceValues(forKeys: [.isDirectoryKey]),
                      values.isDirectory == true,
                      let gitFileURL = pathFromPlainFile(
                        administrativeDirectory.appendingPathComponent("gitdir"),
                        relativeTo: administrativeDirectory
                      ),
                      gitFileURL.lastPathComponent == ".git" else { continue }

                let worktreeURL = gitFileURL.deletingLastPathComponent()
                    .standardizedFileURL
                    .resolvingSymlinksInPath()
                var isDirectory: ObjCBool = false
                guard FileManager.default.fileExists(atPath: worktreeURL.path, isDirectory: &isDirectory),
                      isDirectory.boolValue,
                      let reciprocalDirectory = pathFromGitFile(gitFileURL),
                      reciprocalDirectory == administrativeDirectory.standardizedFileURL.resolvingSymlinksInPath()
                else { continue }

                if !roots.contains(worktreeURL), !discovered.contains(worktreeURL) {
                    discovered.append(worktreeURL)
                }
            }
        }
        return discovered
    }

    private static func commonGitDirectory(for root: URL) -> URL? {
        let dotGit = root.appendingPathComponent(".git")
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: dotGit.path, isDirectory: &isDirectory),
           isDirectory.boolValue {
            return dotGit.standardizedFileURL.resolvingSymlinksInPath()
        }

        guard let administrativeDirectory = pathFromGitFile(dotGit) else { return nil }
        let commonDirectoryFile = administrativeDirectory.appendingPathComponent("commondir")
        return pathFromPlainFile(commonDirectoryFile, relativeTo: administrativeDirectory)
            ?? administrativeDirectory
    }

    private static func pathFromGitFile(_ url: URL) -> URL? {
        guard let text = try? String(contentsOf: url, encoding: .utf8),
              text.hasPrefix("gitdir:") else { return nil }
        let path = String(text.dropFirst("gitdir:".count))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return resolvedPath(path, relativeTo: url.deletingLastPathComponent())
    }

    private static func pathFromPlainFile(_ url: URL, relativeTo base: URL) -> URL? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let path = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return resolvedPath(path, relativeTo: base)
    }

    private static func resolvedPath(_ path: String, relativeTo base: URL) -> URL? {
        guard !path.isEmpty else { return nil }
        let url = path.hasPrefix("/")
            ? URL(fileURLWithPath: path)
            : base.appendingPathComponent(path)
        return url.standardizedFileURL.resolvingSymlinksInPath()
    }
}
