# AIShell overlap seam authoring source

並行契約で発見した責務重複を共通seamへ分割し、統合実装前にbenchmark v2を凍結するためのsource cutover入力。

## TODO source
- ACE-006 benchmark v2のexecution contract、materializer、observer projection、digestを統合実装前に凍結する。（工程状態はLattice正本）
- ACE-014 effective-root project catalogとdurable WorkspaceDeltaJournal retained viewを実装し、context/process共通のroot-scoped observation正本にする。（工程状態はLattice正本）
- ACE-029 RunCheckInvocationPlan共通F契約はLattice工程正本で管理する。
- ACE-044C WorkspaceDeltaJournalとworkspace_waitを統合し、durable cursor replay、gap、timeout/cancelのfocused testを実装する。（工程状態はLattice正本）
- ACE-044D MCPRequestSchedulerへrequest cancellationとsingle writerを分離し、managed job lifecycle非干渉のfocused testを実装する。（工程状態はLattice正本）
