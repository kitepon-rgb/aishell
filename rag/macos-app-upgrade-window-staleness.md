# 起動中のmacOS appをupgradeで差し替えると無言で壊れる

- 出典: 自前実測（2026-07-25、AIShell 0.4.2窓 → 0.4.3 install）。npm側の仕様は [[raw/npm-publishing-2026]]
- 検証日: 2026-07-25
- 確度: 高（実機で発生・隔離環境で再現・修正後の挙動も実測）

## 何が起きるか

npm globalで配布した `.app` を**窓を開いたままupgradeすると、その窓は壊れるのにerrorが出ない**。

- UIは描画され続ける。buttonのhoverもclickも効く
- `runtime.json` への書き込みも成功する（`RuntimeStore` 経路は生きている）
- しかし `NSOpenPanel` / `NSSavePanel` だけが開かない。errorもlogも出ない
- `NSWorkspace.openApplication` 系も同様に失敗しうる

ユーザーから見えるのは「rootを追加ボタンが効かない」だけで、原因を示す情報はUI上に一切ない。

## 原因

npmはglobal packageを更新する時、既存directoryを同じ親の下の `.<name>-XXXXXXXX` へrenameし、
新版を本来のpathへ展開してから退避分を削除する。起動中のprocessはunlinkされたinodeを掴んで
動き続けるため、**processは生きているがbundle pathは実在しない**。macOSのbundle依存API（panel、
LaunchServices経由のapp起動）はbundle実体の解決に失敗し、黙って何もしない。

実測値:

```
lsof -p 33396 | grep MacOS/
→ /opt/homebrew/lib/node_modules/@quolu/.aishell-N2ismJiF/dist/AIShell.app/Contents/MacOS/AIShell
   （このdirectoryは当日11:22の0.4.3 installで削除済み）
```

`ps -axo comm=` もrenameを追うため、退避名を指す実行pathが確認の決め手になる。
`runtime.json` のmtimeが窓の起動より古いことが「追加操作が1度も永続化されていない」証拠になった。

Homebrew caskや手動置換でも、起動中に `.app` を差し替えれば同じ壊れ方をする。npm固有ではない。

## 検知の設計

pathの存在確認だけでは足りない。**同じpathへ別実体が入るin-place置換を見逃す**ため、実体で見る。

| 状態 | 判定 | 復帰手段 |
| --- | --- | --- |
| intact | 起動時と同じidentity | なし |
| 置換 | 同じpathに別実体（device/inode/size/mtimeの差） | そのpathを開き直して自分を終了 |
| 消滅 | pathごと無い | 同じpathからは起動できない。手動で開き直す |
| 判定不能 | 起動時identityが取れなかった | intactへ丸めない |

AIShellでは `AIShellCore/InstallationIntegrity` が判定だけを所有し、1秒pollのrefreshで再評価して
banner表示に載せる（0.4.4）。「判定不能」をintactと同一視しないのは、異常なしと言い換えないため。

install側の警告は前倒し通知でしかない。npm 12は依存packageのlifecycle scriptを既定で実行せず、
`--ignore-scripts` もあるため、**検知の正はapp側に置く**（[[npm-distribution]]）。

## 実測（0.4.4の修正後）

- 隔離copyでbundle directoryをrename退避 → 1秒以内にbannerが「終了」提示で出る
- 同じpathへ別実体をcopy → bannerが「再起動」提示に変わる。押すと新実体からprocessが起動し旧processは終了
- 置換していない同一起動方式では `sample <pid>` のstackに `-[NSSavePanel runModal]` が現れpanelは正常に開く
  → 直接実行やcode signingではなくbundle実体の消失が原因、と切り分けられた

## 落とし穴

- **非アクティブ窓への1回目clickは窓の前面化に消費される**（macOS標準挙動）。banner buttonが
  「効かない」ように見えて実装を疑ったが、窓をactiveにしてからの2回目で正常に動いた。GUI検証時は
  frontmost判定（`lsappinfo front` → `lsappinfo info -only pid`）を先に取る
- 失敗を1秒pollで消える汎用errorへ載せると、失敗自体が無言になる。復旧UIの失敗は復旧UIの上に残す
