# Test Fixtures

These fixtures are generated synthetic data for automated Gamebook tests. They contain no captured gameplay, user media, personal paths, or third-party assets.

Regenerate:

```powershell
npm.cmd run fixtures:generate
```

Verify:

```powershell
npm.cmd run fixtures:verify
```

Use `manifest.json` for hashes, textual descriptions, expected failures, and accessibility descriptions. Fixture files use `.fixture` suffixes where a production extension would otherwise be ignored or tempting to open as a real user project.
