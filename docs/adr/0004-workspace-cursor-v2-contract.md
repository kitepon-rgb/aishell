# ADR 0004: workspace cursor v2契約

- Status: accepted
- Date: 2026-07-21
- Lattice task: `ACE-004`

## Decision

workspace cursorは`ws2:<root_digest>:<exclusion_digest>:<generation>:<sequence>`とする。

- `root_digest`はcanonical root pathと現在のfilesystem identity（device/inode）を束縛する。
- `exclusion_digest`は`.git`、`.build`、`node_modules`を除外する規則versionを束縛する。
- `generation`はruntime内のroot state世代、`sequence`はそのjournal位置である。
- 別root、別除外規則、別generation、未来sequence、形式不正は`CURSOR_EXPIRED`で拒否する。
- 同じpathでroot identityが置換された時は`RESCAN_REQUIRED`を返し、明示full snapshotだけが新世代を作る。
- journal retentionより古いcursorは`CURSOR_EXPIRED`で、silent full scanへfallbackしない。

FSEventsはdirty pathの通知に限定し、現在のdevice/inode、metadata、content SHAとの照合を正本とする。
同じidentityのdelete/create pairだけをrenameへ統合し、identityが違えばdelete＋createのまま返す。
new pathだけが通知されたrenameは現在identityを既存entryへ逆引きしてpairにする。old pathだけの通知はdeleteとして返し、
後続new path通知時に根拠なく過去deltaを書き換えない。
event gap、drop、ID wrap、root change flagは`RESCAN_REQUIRED`である。

除外pathのeventはjournal sequenceへ入れない。symlinkはscan/content read対象にせず、root外contentを読まない。
journal retentionは件数上限で明示し、永続checkpointと時間based retentionはPhase 1で追加する。

## Characterization

`WorkspaceStateRuntimeTests`はcursor各fieldの個別拒否、root置換、retention失効、gap、片側rename、delete、directory rename、
symlink escape、除外path、delta pagingを固定する。これらを緩める変更はschema migrationまたは新cursor prefixを要する。
