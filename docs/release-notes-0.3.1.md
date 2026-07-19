# AIShell 0.3.1 release notes

Date: 2026-07-19

AIShell 0.3.1は、初期高密度tool surfaceの挙動を変えず、process実行境界の意味を明確にするpatch releaseである。

## Clarified

- `sh`、`bash`、`zsh`、`dash`、`ksh`、`csh`、`tcsh`、`fish`、`env`、`osascript`のbasename拒否は、汎用command-string wrapperへの退行を防ぐ製品上の設計レールである。
- この拒否listはsecurity boundaryではない。改名したbinaryや、許可workerが起動する子processまでは阻止しない。
- `run_check`は引き続きdestructive/open-world capabilityである。安全性や隔離をbasename拒否へ依存させない。

## Unchanged

- default profileは`workspace_snapshot`、`read_context`、`search_context`、`run_check`、`artifact_read`の5 tool。
- `AISHELL_TOOL_PROFILE=full`は20 primitiveを加えた25 tool。
- 0.3.0で計測した3-task sentinelの結果と既知の制限に変更はない。
