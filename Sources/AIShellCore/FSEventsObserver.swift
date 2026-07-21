import CoreServices
import Foundation

struct ObservedFileEvent: Sendable {
    let path: String
    let eventID: UInt64
    let flags: FSEventStreamEventFlags

    var requiresRescan: Bool {
        let unsafeFlags = FSEventStreamEventFlags(
            kFSEventStreamEventFlagMustScanSubDirs
                | kFSEventStreamEventFlagUserDropped
                | kFSEventStreamEventFlagKernelDropped
                | kFSEventStreamEventFlagEventIdsWrapped
                | kFSEventStreamEventFlagRootChanged
        )
        return flags & unsafeFlags != 0
    }
}

final class FSEventsObserver: @unchecked Sendable {
    private final class CallbackBox: @unchecked Sendable {
        let callback: @Sendable ([ObservedFileEvent]) -> Void
        init(callback: @escaping @Sendable ([ObservedFileEvent]) -> Void) {
            self.callback = callback
        }
    }

    private let box: CallbackBox
    private let queue: DispatchQueue
    private var stream: FSEventStreamRef?

    init(
        path: String,
        sinceEventID: UInt64? = nil,
        callback: @escaping @Sendable ([ObservedFileEvent]) -> Void
    ) throws {
        box = CallbackBox(callback: callback)
        queue = DispatchQueue(label: "jp.quolu.aishell.fsevents.\(UUID().uuidString)")
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(box).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        let callback: FSEventStreamCallback = { _, info, count, eventPaths, flags, eventIDs in
            guard let info else { return }
            let box = Unmanaged<CallbackBox>.fromOpaque(info).takeUnretainedValue()
            let paths = eventPaths.assumingMemoryBound(to: UnsafePointer<CChar>?.self)
            var events: [ObservedFileEvent] = []
            events.reserveCapacity(count)
            for index in 0..<count {
                guard let rawPath = paths[index] else { continue }
                events.append(ObservedFileEvent(
                    path: String(cString: rawPath),
                    eventID: eventIDs[index],
                    flags: flags[index]
                ))
            }
            if !events.isEmpty { box.callback(events) }
        }
        let createFlags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagFileEvents
                | kFSEventStreamCreateFlagWatchRoot
        )
        guard let created = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            [path] as CFArray,
            sinceEventID ?? FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.1,
            createFlags
        ) else {
            throw AIShellError.invalidPath("FSEvents streamを作成できません: \(path)")
        }
        stream = created
        FSEventStreamSetDispatchQueue(created, queue)
        guard FSEventStreamStart(created) else {
            FSEventStreamInvalidate(created)
            FSEventStreamRelease(created)
            stream = nil
            throw AIShellError.invalidPath("FSEvents streamを開始できません: \(path)")
        }
    }

    func flush() {
        guard let stream else { return }
        FSEventStreamFlushSync(stream)
    }

    deinit {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
    }
}
