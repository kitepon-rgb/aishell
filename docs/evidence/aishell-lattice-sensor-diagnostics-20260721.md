# AIShellでのLattice 0.11.2 sensor diagnostics実証

- Date: 2026-07-21
- Lattice commit: `e5b4717`
- npm package: `@quolu/lattice@0.11.2`

Phase 0 accept後、milestone commit前のsensor収載確認で、未初期化projectへの`lattice sensor sync . --json`が
汎用`LATTICE_SENSOR_COMMAND_FAILED`だけを返す問題を発見した。AIShell側で回避せずLattice本体を修正し、
docs、focused test、full CI、commit、main push、npm publish、registry版global installまで完了した。

公開0.11.2で同じ操作を再実行し、次を確認した。

- `npm view @quolu/lattice version`: `0.11.2`
- `lattice --version`: `0.11.2`
- 未初期化sync: `LATTICE_SENSOR_NOT_INITIALIZED`、exit code 1、bundled sensor stderr、
  `lattice sensor init . --json`の`next_action`
- `lattice sensor init . --json`: status `ok`
- 続く`lattice sensor sync . --json`: status `ok`
- Lattice source repo: clean

silent init、fallback、暗黙retryは追加していない。sensor DBは`.lattice/sensor/.gitignore`により配布対象外とし、
projectには所有境界だけを残す。
