# Security Policy

## Reporting a vulnerability

Email **security@diagrams.so**. Please include a description of the issue, reproduction steps, and the affected component. We acknowledge reports within 3 business days and follow the coordinated-disclosure process in our [Vulnerability Disclosure Policy](https://diagrams.so/policy/vulnerability-disclosure), which includes a safe harbor for good-faith research.

Please do not open public GitHub issues for security reports.

## Scope notes for this repository

- The MCP server runs locally on your machine and connects only to `api.diagrams.so`. It contains no telemetry and sets no cookies; it sends first-party headers identifying the client version.
- Credentials obtained through `login` are stored at `~/.diagrams-so/credentials.json` with owner-only file permissions. The `DIAGRAMS_API_KEY` environment variable takes precedence when set. Treat both like passwords; revoke a key in the dashboard if it may have been exposed (revocation is immediate).
- Test-mode keys (`dgz_test_`) are **not** a sandbox: they read and write the same real account — creating, editing and deleting real diagrams — and run real AI calls. The only difference is a lower rate limit (20 requests/minute instead of 60) and `livemode: false` on the ledger rows, so a leaked test key deserves exactly the same urgency as a leaked live key.

## Supported versions

Security fixes land in the latest release. Older majors receive fixes at our discretion; please stay current.
