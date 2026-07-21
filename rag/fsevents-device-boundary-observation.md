# FSEvents device timestamp boundaryの実測制約

- 出典: local macOS SDK `FSEvents.h`、Apple FSEvents一次資料、AIShell focused実測
- 取得日: 2026-07-21
- 確度: 高（API契約と同一host実測）、cross-host restoreの実機再現は未実施

## API契約

local SDKの`FSEvents.h`は、per-device streamがcallbackで処理したlatest event IDをdevice UUIDと組で永続保存し、次回UUIDが
一致する場合に`FSEventStreamCreateRelativeToDevice`の`sinceWhen`へ再投入できると明記する。一方、
`FSEventsGetLastEventIdForDeviceBeforeTime`は指定時刻以前のconservativeなdevice境界を返すAPIである。

## 実測

Data volume上でfileを生成し200 ms間隔で30回（約6秒）観測したところ、system current IDは増加したが
`FSEventsGetLastEventIdForDeviceBeforeTime(device, now)`は同じ値に留まった。これを直後restart時のcallback latest IDと
直接比較すると、正常なcheckpointをvolume rollbackと誤判定する。

同じtimestamp boundaryをcheckpoint watermarkとして強制した試作では、既適用historical eventの再処理により120 file
benchmarkのwarm content readが0から480へ悪化した。この経路は採用しない。

## AIShellの判断

- 初回observerはdevice timestamp boundaryをconservativeな開始点にする。
- その後はper-device streamで同期処理したcallback latest IDだけへwatermarkを進め、同じdeviceのFSEvents UUIDと組で保存する。
- UUID不一致・取得不能、drop/wrap/root-change、保存IDがsystem currentより未来の場合はfail-closedにする。
- timestamp boundaryの遅延値を直後restartのrollback判定へ流用しない。

この判断はper-host streamへの回帰ではない。stream、callback ID、UUIDはper-device系列へ統一したまま、timestamp検索APIの
用途だけを初回conservative baselineへ限定する。
