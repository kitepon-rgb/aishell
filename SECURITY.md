# Security policy

## Supported versions

Security fixes are applied to the latest published release. Older experimental releases are not maintained separately.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use **Security → Report a vulnerability** on the GitHub repository to submit a private report. Include:

- the affected AIShell and macOS versions;
- the required allowed-root and runtime state;
- minimal reproduction steps;
- the observed impact;
- whether the issue requires an allowed worker or child process.

AIShell's shell-basename rejection and allowed-root model are product rails, not a sandbox or general code-execution security boundary. Reports should distinguish a bypass of an advertised contract from behavior that already requires an explicitly allowed open-world worker.

The maintainer will acknowledge a complete report as soon as practical and coordinate disclosure after a fix or documented resolution is available.
