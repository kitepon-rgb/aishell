# GitHub public repository settings

- 取得日: 2026-07-19
- 確度: 高
- 一次資料: [[raw/github-repository-security-settings-2026-07-19]]

## Private vulnerability reporting

公開repositoryではprivate vulnerability reportingを有効化すると、Security Advisories画面に非公開報告入口が表示される。repository admin権限を持つactorは`PUT /repos/{owner}/{repo}/private-vulnerability-reporting`で有効化でき、`GET`は`enabled` booleanを返す。無効化は同じendpointへの`DELETE`でrollbackできる。

AIShellは`SECURITY.md`からこのprivate入口へ案内し、public issueへの脆弱性投稿を避ける。設定後はAPIの`enabled: true`を受入証拠にする。

## Social preview

GitHub Social previewはrepository Settings UIからuploadする。AIShellの1280×640 PNGはUIの1 MB上限を超えたため、同じ画像を162 KBの高品質JPEGへ変換してuploadした。受入は`gh repo view`の`usesCustomOpenGraphImage: true`と専用`repository-images` URLで確認する。
