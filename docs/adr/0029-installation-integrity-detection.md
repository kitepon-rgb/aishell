# ADR 0029: install置換で古くなった窓の検知

- Status: accepted
- Date: 2026-07-25
- 対象version: AIShell 0.4.4

## 背景

`npm install -g @quolu/aishell` で0.4.3を入れた時、3日前に起動した0.4.2の窓が開いたままだった。
その窓で「rootを追加」を押しても何も起きず、errorもlogも出なかった。

npmはglobal packageの更新時に既存directoryを `@quolu/.aishell-XXXX` へrenameし、新版を本来のpathへ
展開してから退避分を削除する。起動中のprocessはunlinkされたinodeを掴んで動き続けるため、processは
生きているのにbundle pathは実在しない。UIの描画、click、`RuntimeStore` への書き込みはすべて成功し、
bundle実体を要求するAPI（`NSOpenPanel`、LaunchServices経由の起動）だけが黙って何もしなくなる。

実測と切り分けは [[../../rag/macos-app-upgrade-window-staleness]] に置いた。Homebrew caskや手動置換でも
起動中に `.app` を差し替えれば同じ壊れ方をするため、npm固有の問題として扱わない。

## 決定

### 1. 実体identityで3状態を判定する（採用・実装済み）

`AIShellCore/InstallationIntegrity` が判定だけを所有する。起動時に実行ファイルの
device / inode / size / mtime を記録し、`AppModel.refresh()`（1秒poll）で再取得して比較する。

| 状態 | 条件 |
| --- | --- |
| `intact` | 起動時と同じidentity |
| `executableReplaced` | pathは在るがidentityが違う（in-place置換） |
| `executableRemoved` | pathが無い（退避後に削除された旧install） |
| `unknown` | 起動時のidentityが取れなかった |

**pathの存在確認だけにしないのは、同じpathへ別実体が入る置換を見逃すからである。** npmのrename退避は
`executableRemoved` に、同一pathへの上書き配布は `executableReplaced` になる。`unknown` を `intact` へ
丸めないのは、判定不能を「異常なし」と言い換えないため。

判定は観測専用とする。操作を止めず、勝手に終了せず、`runtime.json` を触らない。

### 2. 復帰手段は状態ごとに分ける（採用・実装済み）

置換・消滅を検知したらheaderの上にbannerを出し、影響する操作（ファイル選択を伴うもの）と復帰手段を
明示する。復帰手段は状態で変える。

- `executableReplaced`: そのbundle pathを `NSWorkspace.openApplication`
  （`createsNewApplicationInstance = true`）で開いてから自分を終了する
- `executableRemoved`: 同じpathからは起動できないため、終了して `aishell-open` での開き直しを促す

再起動の失敗は banner と stderr に残す。**1秒pollのrefreshが消す汎用 `errorMessage` へ載せない。**
復旧UIの失敗が無言になると、元の症状（押しても何も起きない）と区別できなくなる。失敗後はbannerの
提示を手動での開き直しへ切り替え、効かない再起動を勧め続けない。

### 3. install側の前倒し警告は撤回する（0.4.4で採用、0.4.5で撤回）

0.4.4では `postinstall` で `scripts/check-running-instances.mjs` を実行し、置き換えられる実体を掴んだ
ままの窓のpidを挙げて再起動を促した。**実installで走らなかったため撤回した。**

```
npm install -g @quolu/aishell@0.4.4   （npm 11.17.0）
→ npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts:
   npm warn allow-scripts   @quolu/aishell@0.4.4 (postinstall: node scripts/check-running-instances.mjs)
```

`npm config get allow-scripts` は空で、user/project設定ではなくnpmの既定挙動である。「依存packageの
lifecycle scriptが既定offになるのはnpm 12から」と文書化されていたが、**npm 11.17.0の時点でglobalへ
直接installする自package自身のscriptもblockされる**。したがってこの警告は既定で永久に出ないのに、
`allow-scripts` の警告行だけが全利用者のinstallへ増える。前倒し通知の価値が0でコストだけが残る。

`scripts/check-running-instances.mjs` を削除し、`scripts/verify-npm-package.mjs` に
「`preinstall` / `install` / `postinstall` を持たない」assertionを置いて再導入を機械gateで止める。
install scriptへ機能を載せないという配布判断（[[../../rag/npm-distribution]]）へ戻した形である。

**この撤回で失われるのは前倒し通知だけで、検知そのものは決定1・2のapp側が全部持っている。**

## 検討して採らなかった案

- **bundle pathの存在確認だけで済ませる**: in-place置換を検知できない。配布経路をnpmに限定する前提も
  持ちたくない。
- **置換を検知したら操作を止める**: 書き込み経路は生きており、止めると復旧のための設定変更もできなく
  なる。壊れているのはファイル選択を伴う経路だけなので、事実をそのまま示す方が正しい。
- **`postinstall` で古い窓を自動終了する**: 利用者の窓をinstall scriptが黙って落とすことになる。
  未保存の操作を巻き込む可能性があり、install scriptの責務を超える。
