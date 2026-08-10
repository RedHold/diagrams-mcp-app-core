# Contributing

Thanks for helping improve the Diagrams.so MCP server.

## Ground rules

- **Licensing.** This project is licensed under Apache-2.0. By submitting a contribution, you agree it is licensed under the repository's license (Apache License 2.0, Section 5: contributions are under the same terms unless you state otherwise). Only submit work you have the right to contribute.
- **No secrets.** Never include API keys, tokens, or customer data in code, tests, fixtures, or commit history. Test with your own account and remember that `dgz_test_` keys bill that account's real Credit balance.
- **Service terms still apply.** The code is open source; calls it makes to `api.diagrams.so` are governed by the [Terms of Service](https://diagrams.so/policy/terms) and [Acceptable Use Policy](https://diagrams.so/policy/acceptable-use).
- **Security issues** go to security@diagrams.so per [SECURITY.md](./SECURITY.md), not to the issue tracker.

## Development

```bash
npm ci
npm run build
node scripts/ci-smoke.mjs   # verifies all tools register; no API calls, no credits
```

The live smoke test (`npm run smoke`) exercises the real API and spends credits; it needs `DIAGRAMS_API_KEY` set and is normally left to CI.

## Pull requests

- Keep changes focused and match the existing style.
- Update `CHANGELOG.md` and keep `manifest.json`, `server.json`, and `package.json` versions in sync (`scripts/check-version-sync.mjs` checks this).
- Tool descriptions are user-facing; state clearly when a tool costs credits.

## Conduct

Be respectful and constructive. See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Questions: success@diagrams.so.
