# ACE-044d MCP request scheduler

- Lattice task: `ACE-044d`
- Date: 2026-07-23

## 実装

- stdin受付とrequest実行を`MCPRequestScheduler`へ分離した。受付loopは長いtool callの完了を待たず、後続requestとcancel notificationを受理する。
- request handlerは1本ずつ実行するqueueとし、既存`MCPServer`の可変stateを未検証の並行実行へ晒さない。
- `notifications/cancelled`の`requestId`でactive Taskをcancelし、queued requestは実行前に除去する。
- cancelしたrequestはJSON-RPC error `-32800 Request cancelled`を返し、その後のrequest処理を継続する。
- stdoutは`MCPResponseWriter` actorだけが改行付きJSONを出力し、複数responseのbyte interleaveを防ぐ。
- request Taskのcancellationと、既に独立所有へ移ったmanaged jobのlifecycleを分離した。

## focused verification

```text
swift test --filter MCPRequestSchedulerTests
Executed 4 tests, with 0 failures

swift test --filter AIShellMCPTests
Executed 39 tests, with 0 failures
```

確認した境界:

- active request cancellation後にqueued requestが正常完了する。
- queued cancellationはhandlerを一度も呼ばない。
- 40 responseが40個の完全なJSON lineとして出力される。
- request cancellation後もdetached managed jobは完了する。
- 既存Tool Catalog、schema、成功・失敗wire、expanded capability gateは不変。
