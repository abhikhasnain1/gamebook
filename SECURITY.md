# Security Policy

Gamebook is pre-release software. Security reports are accepted for the current development branch and the latest published release when one exists.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use [GitHub private vulnerability reporting](https://github.com/abhikhasnain1/gamebook/security/advisories/new) and include:

- A concise description and affected version or commit.
- Reproduction steps or a minimal proof of concept.
- Expected and observed behavior.
- Security or privacy impact.
- Any known mitigations.

Do not attach sensitive project files, gameplay footage, credentials, personal data, or diagnostic logs unless requested through the private report.

## Project security boundaries

Gamebook's data posture, archive validation, media protocol, diagnostics, capture privacy, export privacy, and update requirements are defined in [the security and privacy specification](docs/SECURITY-PRIVACY.md). Security fixes must preserve project data and recovery paths and include regression coverage.
