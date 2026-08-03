# Gamebook schemas

These JSON Schema 2020-12 documents are the accepted machine-readable Gamebook version 2 architecture contract. They do not indicate that version 2 persistence is implemented in Gamebook 0.5.3.

| Schema | Owner | Canonical scope |
| --- | --- | --- |
| `project-v2.schema.json` | Archive and validated project command boundary | Manifest, assets, evidence, timelines, pages, research records, and Project Trash |
| `global-settings-v1.schema.json` | Global settings service | Capture, shortcuts, playback, accessibility, storage, Trash, and diagnostics preferences |
| `workspace-v1.schema.json` | Native workspace service | Workspace state, lock, recovery journal, and Save journal |
| `migration-repair-v1.schema.json` | Native migration and repair services | Deterministic migration and read-only repair reports |

JSON Schema validates document shape. The contract verifier also checks archive security, cross-record references and order, source retention, exact timelines, derived-cache boundaries, version 1 compatibility evidence, and the valid/invalid fixture matrix.

```powershell
npm.cmd run project-format-contract:verify -- --self-test
npm.cmd run project-format-contract:verify -- --reference docs/spikes/project-format-freeze-reference-report.json
```

Changes to a canonical record require a new compatible record version or project-format decision and corresponding migration fixtures. Unknown project record fields fail closed. Unknown global setting values may be preserved only where the settings schema explicitly permits them; invalid known values fall back individually.
