# AIShell parallel expansion authoring source

Lattice compile/verifyで非交差を確認したCore責務を、既存複合TODOから分離するためのsource cutover入力。

## TODO source
- ACE-012A WorkspaceCheckpointStoreとwarm restore/corruption focused testを専用fileへ実装する。（工程状態はLattice正本）
- ACE-012B ObservationJournalとevent ID/gap/retention focused testを専用fileへ実装する。（工程状態はLattice正本）
- ACE-023A GitContextProviderとdiff budget/continuation focused testを専用fileへ実装する。（工程状態はLattice正本）
- ACE-023B ProjectProfileServiceとinvalidation focused testを専用fileへ実装する。（工程状態はLattice正本）
- ACE-023C SearchContextService v2とshared budget/dedup/continuation focused testを専用fileへ実装する。（工程状態はLattice正本）
- ACE-034A CheckFreshnessCacheとfalse-fresh/corruption/TTL focused testを専用fileへ実装する。（工程状態はLattice正本）
- ACE-034B ChangeImpactServiceとprovenance/freshness focused testを専用fileへ実装する。（工程状態はLattice正本）
- ACE-044A ManagedProcessRegistryとobserve/cancel/restart focused testを専用fileへ実装する。（工程状態はLattice正本）
- ACE-044B ArtifactQueryServiceと横断search/history compare focused testを専用fileへ実装する。（工程状態はLattice正本）
- ACE-052A ChangeSetServiceとatomicity/rollback/stale SHA focused testを専用fileへ実装する。（工程状態はLattice正本）
