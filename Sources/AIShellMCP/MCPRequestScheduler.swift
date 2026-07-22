import Foundation

actor MCPResponseWriter {
    typealias Sink = @Sendable (Data) async -> Void

    private let sink: Sink

    init(sink: @escaping Sink = { data in
        FileHandle.standardOutput.write(data)
    }) {
        self.sink = sink
    }

    func write(_ response: JSONRPCResponse) async throws {
        var data = try JSONEncoder.aishell.encode(response)
        data.append(0x0A)
        await sink(data)
    }
}

actor MCPRequestScheduler {
    typealias Handler = @Sendable (JSONRPCRequest) async -> JSONRPCResponse?

    private struct Pending: Sendable {
        let request: JSONRPCRequest
        let key: String?
    }

    private let handler: Handler
    private let writer: MCPResponseWriter
    private var queue: [Pending] = []
    private var activeKey: String?
    private var activeID: JSONValue?
    private var activeCancelled = false
    private var activeTask: Task<Void, Never>?
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []

    init(writer: MCPResponseWriter, handler: @escaping Handler) {
        self.writer = writer
        self.handler = handler
    }

    func submit(_ request: JSONRPCRequest) async {
        if request.method == "notifications/cancelled", request.id == nil {
            if let requestID = request.params?.objectValue?["requestId"] {
                await cancel(requestID: requestID)
            }
            return
        }

        let key = request.id.flatMap(Self.requestKey)
        if let key, activeKey == key || queue.contains(where: { $0.key == key }) {
            try? await writer.write(.failure(
                id: request.id ?? .null,
                code: -32600,
                message: "同じrequest idが処理中です。"
            ))
            return
        }
        queue.append(Pending(request: request, key: key))
        startNextIfNeeded()
    }

    func waitUntilIdle() async {
        guard activeTask != nil || !queue.isEmpty else { return }
        await withCheckedContinuation { continuation in
            idleWaiters.append(continuation)
        }
    }

    private func cancel(requestID: JSONValue) async {
        guard let key = Self.requestKey(requestID) else { return }
        if activeKey == key {
            activeCancelled = true
            activeTask?.cancel()
            return
        }
        if let index = queue.firstIndex(where: { $0.key == key }) {
            let pending = queue.remove(at: index)
            if let id = pending.request.id {
                try? await writer.write(Self.cancelledResponse(id: id))
            }
            resumeIdleWaitersIfNeeded()
        }
    }

    private func startNextIfNeeded() {
        guard activeTask == nil, !queue.isEmpty else { return }
        let pending = queue.removeFirst()
        activeKey = pending.key
        activeID = pending.request.id
        activeCancelled = false
        let handler = self.handler
        activeTask = Task { [weak self] in
            let response = await handler(pending.request)
            let taskWasCancelled = Task.isCancelled
            await self?.complete(response: response, taskWasCancelled: taskWasCancelled)
        }
    }

    private func complete(response: JSONRPCResponse?, taskWasCancelled: Bool) async {
        if (activeCancelled || taskWasCancelled), let activeID {
            try? await writer.write(Self.cancelledResponse(id: activeID))
        } else if let response {
            try? await writer.write(response)
        }
        activeTask = nil
        activeKey = nil
        activeID = nil
        activeCancelled = false
        startNextIfNeeded()
        resumeIdleWaitersIfNeeded()
    }

    private func resumeIdleWaitersIfNeeded() {
        guard activeTask == nil, queue.isEmpty else { return }
        let waiters = idleWaiters
        idleWaiters.removeAll(keepingCapacity: false)
        waiters.forEach { $0.resume() }
    }

    private static func cancelledResponse(id: JSONValue) -> JSONRPCResponse {
        .failure(id: id, code: -32800, message: "Request cancelled")
    }

    private static func requestKey(_ id: JSONValue) -> String? {
        switch id {
        case .string, .number, .null:
            return (try? JSONEncoder.aishell.encode(id))?.base64EncodedString()
        default:
            return nil
        }
    }
}
