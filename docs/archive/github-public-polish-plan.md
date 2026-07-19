# GitHub public polish plan

AIShellのGitHub公開面を、初見で価値が伝わり、実装・配布・履歴と矛盾しない状態へ整える。

## 成功条件

- [x] 5秒で用途とDirect OSの差分が伝わるREADME冒頭、30秒で試せる導線、比較表を用意する。
- [x] 硬派なmacOS開発toolに合うhero / Social previewを生成し、過剰な装飾や風化しやすいUI表現を避ける。
- [x] description、topics、homepage、Discussions、Community Profile、security設定を意図どおり揃える。
- [x] npm package、default branch、tag、GitHub Release、release notesの対応を検証可能にする。
- [x] ローカル変更、GitHub設定変更、手動作業、未解決事項を分けて報告する。

## Phase 1: 監査と裁定

- [x] README、メタデータ、CI、Release、tag、画像、Community Profileをread-onlyで監査する。
- [x] 既存知識（Caveat / `rag/INDEX.md`）に重複する調査がないことを確認する。
- [x] 監査結果、効果 / コスト、推奨実施範囲、画像方向を提示し、完成をthread goalとして固定する。
- [x] `v0.3.0`が`main`の祖先でない理由をnpm公開時刻・tag内容・npm `gitHead`で照合する。
- [x] 既存`v0.3.0`を維持し、0.3.0 / 0.3.1 notesを公開実態へ訂正して`v0.3.1`をnpm `gitHead`へ付ける方針を裁定する。

## Phase 2: 再利用知識の還流

- [x] dotagentsの`polish-github`正本へCommunity Profile、security、default branch、tag ancestry、package / tag / Release整合の監査を追加する。
- [x] skill validatorとdiff確認を通し、既存のGOゲートと外部変更告知を維持する。

## Phase 3: ローカル公開資産

- [x] README hero、30秒例、比較表、導線、英語主版 / 日本語版を実装する。
- [x] Apache-2.0の裁定を得てLICENSEとpackage metadataへ反映する。SECURITY / CONTRIBUTING / Issue・PR templatesは追加済み。
- [x] imagegenでOG / heroを作り、1280×640、文字、再現性、GitHub upload用JPEGを確認する。
- [x] READMEリンク、Markdown、画像参照、YAML、Swift 42/42、app packaging、npm dry-runを検証する。

## Phase 4: GitHub外部状態

- [x] 実行前に目的、影響、rollbackを告知する。
- [x] description、topics、homepage、Discussions維持、Wiki / Projects無効化、private vulnerability reportingを反映する。
- [x] 承認済みのtag / Release操作だけを実行し、release notesと実commitを再確認する。
- [x] Social preview用JPEGをSettings UIへuploadし、custom OG URLをAPIで確認する。

## Phase 5: 最終受入

- [x] GitHub公開ページ、README、Release、Community Profileを再監査する。
- [x] 変更ファイル、検証結果、スキップ理由、手動残作業を報告する。
- [x] 完了後、このplanを`docs/archive/`へ移す。

## 完了証拠

- npm `@quolu/aishell@0.3.2`: `gitHead=775abd278f983519663e6903f1345c59904c2b27`、`latest=0.3.2`、`license=Apache-2.0`。
- GitHub: `v0.3.0`、`v0.3.1`、`v0.3.2` Release公開、`v0.3.2`をlatestに設定。
- tag: `v0.3.1`はnpm 0.3.1の`gitHead=20ef0ce8fb6ef6551e42e64c6240977d7c28339d`、`v0.3.2`はnpm 0.3.2の`gitHead`と一致。
- GitHub Actions: 初回run `29688176713`の`rg`不足をworkflowで修正し、run `29688309075`でtest、app packaging、npm payloadをgreen確認。
- GitHub repository: Apache-2.0検出、custom Social preview、private vulnerability reporting、secret scanningとpush protectionを確認。
- global install: `/opt/homebrew/lib/node_modules/@quolu/aishell`を0.3.2へ更新し、MCP `2025-11-25` initialize、server 0.3.2、既定5 toolを確認。
- dotagents: `polish-github`の再利用知識をcommit `70deaa5eba08b1560294c088fb92c0ba11174994`としてpush。既存dirty fileは対象外。

Code of Conductは執行主体・連絡先を未裁定のまま数字合わせで追加しない。YAML Issue Formsは配置・内容を確認済みだが、Community Profile APIのlegacy `issue_template`欄には算入されない。

## 非目標

- AIShell本体の機能・MCP公開挙動・benchmarkを変更しない。
- 見栄えのために未検証の性能値やsecurity主張を追加しない。
- GO前にREADME、画像、GitHub設定、tag、Releaseを変更しない。
- 既存tagのforce更新や履歴改変を暗黙に行わない。

## 既知の罠

- GitHub Social previewはAPIから設定できず、Settings UIでの手動アップロードが必要。
- `v0.3.0`は`main`の祖先ではないが、npmで先に公開した`factory_diagnostics`版0.3.0を指す正当なtagである。mainでは後から別内容の高密度runtimeを0.3.0として記録し、npm 0.3.1（`gitHead=20ef0ce`）として公開したため、main上の0.3.0 / 0.3.1 release notesと公開差分が一致しない。既存tagの移動では直さない。
- dotagentsには先行commitと既存dirty fileがあるため、対象pathを限定し、既存変更を巻き込まない。
- 画像内へバージョン番号やUIスクリーンショットを焼き込むと早く風化する。

## 検証

- docs / README / skill変更: Markdownリンク、画像参照、`git diff --check`、対象diff。
- skill変更: `skill-creator`の`quick_validate.py`と正本 / Codex入口の参照確認。
- GitHub状態: `gh repo view`、Community Profile API、`gh run list`、`gh release list`、tag ancestry。
- Swift実装自体は変更していない。公開CI run `29688309075`で42 test、app packaging、npm payloadを最終確認する。
