# ADR 0003: 拡張development surface契約

- Status: accepted
- Date: 2026-07-21
- Control: `aishell-capability-expansion-20260721`
- Lattice task: `ACE-003`

## Decision

development surfaceは高密度tool 9本を上限とし、常時利用可能な復旧control 2本を別枠で維持する。
したがって受入後のdefault `tools/list`は最大11本、fullは既存25本へ新規4本を加えた最大29本である。
「default 9」はdevelopment toolの数であり、設定不能・pause中にも必要なcontrolを隠す意味ではない。

tool順、責務、成功result schemaを次で固定する。

| 順 | Tool | 所有する成果 | 成功result |
|---:|---|---|---|
| 1 | `run_check` | 直接起動、freshness cache、focused pipeline、非同期run開始、structured diagnostic | `aishell.run-check.v2` |
| 2 | `run_observe` | AIShell所有runのstatus、incremental diagnostic/tail、wait、cancel | `aishell.run-observe.v1` |
| 3 | `artifact_read` | 単一range/tailに加え、複数artifact検索、run比較、diagnostic group | `aishell.artifact-read.v2` |
| 4 | `workspace_snapshot` | 永続index、delta、Git diff、project profile、worktree比較 | `aishell.workspace-snapshot.v2` |
| 5 | `workspace_wait` | cursor以後のOS変更待機、timeout/cancel、event-gap判定 | `aishell.workspace-wait.v1` |
| 6 | `read_context` | 複数file、line/symbol range、expected SHA、共有budgetとcontinuation | `aishell.read-context.v2` |
| 7 | `search_context` | 複数query、regex/glob、lexical/semantic provider、共有budgetとranking | `aishell.search-context.v2` |
| 8 | `change_impact` | 変更symbol、reference/dependency、関連test、focused check候補と根拠 | `aishell.change-impact.v2` |
| 9 | `apply_change_set` | expected SHA付きmulti-file transaction、result diff、更新後cursor | `aishell.apply-change-set.v1` |

`change_impact`のv2はADR 0012によるversioned amendmentであり、tool名、責務、公開順、feature gateは変えない。

ACE-034の実装cutoverでは、`MCPServer`と`DevelopmentRuntimeService`が同じ`ProjectProfileService`、
`FocusedCheckService`、`ChangeImpactService`を共有する。したがって`change_impact recommend`が発行したsetは、
別registryへの複製やcaller捏造hashを挟まず、同じserver lifetimeの`run_check`から再照合できる。
`start`はACE-044のmanaged lifecycle実装まで`RUN_CHECK_START_NOT_READY`・process 0で明示的に停止し、
同期実行へfallbackしない。

この後ろへ`runtime_status`、`runtime_open_manager`を固定順で置く。full profileだけが残る18 primitiveは
その後ろへ次の現行順で置く。

1. `files_list`
2. `files_search`
3. `files_read_text`
4. `files_stat`
5. `files_tree`
6. `files_create_directory`
7. `files_create_text`
8. `files_write_text`
9. `files_replace_text`
10. `files_copy`
11. `files_move`
12. `files_rename`
13. `files_trash`
14. `apps_list_running`
15. `apps_list_installed`
16. `apps_open`
17. `apps_activate`
18. `process_run`

したがってfull 29本はdevelopment 9本、復旧control 2本、full-only 18本の順である。既存20 primitiveは
復旧control 2本とfull-only 18本として全て残る。tool definitionへtimestamp、cwd、runtime状態を混ぜない。

## Responsibility boundaries

- `run_check`はrunを作る。作成後の長時間観測とcancelは`run_observe`だけが行う。
- `artifact_read`は既に保持された証拠を読む。process lifecycleを変更しない。
- `workspace_snapshot`は現在状態を返す。将来の変更を待つのは`workspace_wait`だけである。
- `change_impact`は根拠付き候補を返す。callerの明示なしにtestを実行しない。
- `apply_change_set`だけが複数fileを一transactionで変更する。silent partial successは禁止する。
- diagnostic adapter、Git、`rg`、SourceKit-LSP、depfileはworker/providerであり、公開toolを増やさない。

## Compatibility and feature gate

- 実装中は`AISHELL_CAPABILITY_SET=expanded-v1`を明示した時だけ拡張9本を公開する。未指定時は
  0.3.3の高密度5本＋復旧control 2本を維持する。不正値はstartupでtyped failureにし、黙って旧面へ戻さない。
- `AISHELL_TOOL_PROFILE`は未指定、`development`、`full`、既存互換aliasの`legacy`だけを受理する。
  `legacy`は`full`と同義に保つ。未知値と空文字は`INVALID_TOOL_PROFILE`でstartupを停止し、黙ってdevelopmentへ戻さない。
  expanded flagと`full`または`legacy`を組み合わせた時だけ最大29本になる。
- product gate受入後の次minorでexpanded-v1をdefaultへ昇格する。受入前にdefaultを切り替えない。
- default昇格minorをNとすると、既存5 toolのv1 inputはNとN+1で受理し、N+2から削除可能とする。
  意味が曖昧な省略値はv2へ推測変換せず、v1既定値を使う。v1 resultが必要なclientは同期間
  `AISHELL_SCHEMA_COMPAT=v1`を明示できる。`AISHELL_SCHEMA_COMPAT`は未指定または`v1`だけを受理し、
  未知値と空文字は`INVALID_SCHEMA_COMPAT`でstartupを停止する。
- default昇格後も`AISHELL_CAPABILITY_SET=expanded-v1`はNとN+1で冪等な互換aliasとして受理する。
  `AISHELL_CAPABILITY_SET`は未指定または`expanded-v1`だけを受理し、未知値と空文字は
  `INVALID_CAPABILITY_SET`でstartupを停止する。
- 新規4 toolにv0互換はない。未知field、未知action、cursor/schema mismatchはtyped errorとする。

## Non-reduction preservation table

0.3.3 defaultの5 toolは名前だけでなく、次のv1 capabilityをv2経路でも保存する。高密度化は同じ呼出しへ
複数query・観測を束ねる変更であり、この表のinput mode、結果、errorを削除する変更ではない。

| 現行tool | 保存するv1 capability | v2での所有先 |
|---|---|---|
| `run_check` | shellを介さないexecutable/arguments/cwd/env、timeout、retention、passed/failed/timed_out、完全stdout/stderr handle | `run_check` v2の同期互換actionと非同期start action |
| `artifact_read` | `range`、`tail`、`around`の3 mode、byte budget、SHA、expiry、lossless handle read | `artifact_read` v2の単一read action。検索・比較は追加action |
| `workspace_snapshot` | 明示full、cursor delta、bounded entry、embedded context、Git status、gap/expiredのtyped error | `workspace_snapshot` v2。永続checkpoint/profile/worktreeは追加field |
| `read_context` | 複数target、共有byte budget、SHA、omitted bytes、continuation | `read_context` v2のfile target。line/symbol rangeは追加target kind |
| `search_context` | fixed-string query、path、result/byte budget、changed-file ranking、continuation、`CONTENT_CHANGED` | `search_context` v2の単一query。regex/glob/semanticとbatchは追加query kind |
| recovery controls | `runtime_status`と`runtime_open_manager`を停止中も利用可能 | 同名・同責務で別枠維持 |
| full profile | 既存20 primitiveを現行順・互換schemaで公開 | 末尾へ現行順で維持し、拡張4 toolだけを追加 |

意図的廃止は本ADRでは0件である。この保存表を変更する場合は、別ADR、移行期間、代表suiteの比較証拠を必須とする。

## MCP annotations

- read-only: `artifact_read`, `workspace_snapshot`, `workspace_wait`, `read_context`, `search_context`, `change_impact`
- destructive/open-world: `run_check`
- destructive: `run_observe`（cancelを含むため）、`apply_change_set`
- `workspace_wait`は待機してもfilesystemを変更せずread-onlyである。

## Discovery acceptance

日英各9 positive promptと日英各1 no-call controlは`benchmarks/tool-discovery-probes.v1.json`を正本とする。
positive probeはexact expected tool、混同しやすい禁止候補、呼出し要否を持つ。no-call controlは9本すべてを
禁止候補にする。両言語20/20、誤routing 0、不要呼出0を受入条件にする。
このgateはexpanded surfaceを持つcandidateだけへ適用し、nativeと0.3.3 armの機能比較へcandidate固有tool名を要求しない。
model入力は`render-tool-discovery-prompt.mjs`が返すpromptだけで、expected toolと禁止候補はharness-onlyにする。
実測traceはpositiveなら期待toolちょうど1回、no-callなら0回だけを成功とし、同じtoolの重複を含む余計なcallを許さない。
ここではprompt、期待値、renderer、evaluatorを凍結し、modelによる実測受入はACE-065で行う。

## Consequences

default catalogはcontrol込みで11本になるため「9本」と「実際のtools/list 11本」を混同しない。
また、既存5本の意味変更はresult v2で可視化される。機能を実装しただけではdefaultへ昇格せず、
代表suiteと日英discoveryの両方を通す必要がある。
