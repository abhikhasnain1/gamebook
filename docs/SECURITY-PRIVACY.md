# Gamebook Security and Privacy Specification

> Status: Required specification for version 1 and every feasibility spike. This document defines local-data, media-serving, diagnostics, import, export, audio, and update boundaries.

## Data posture

Gamebook is local-first. Projects may contain sensitive gameplay footage, voice chat, notifications, account names, accessibility findings, unreleased builds, and personal research notes.

Version 1 has no account, cloud storage, remote telemetry, advertising, or automatic media upload. Optional cloud processors are post-version 1 and require a separate provider review and explicit per-operation consent.

`.gamebook` archives are not encrypted by Gamebook in version 1. The application states this in project and privacy documentation and relies on Windows account permissions, BitLocker, EFS, or an encrypted storage location when confidentiality is required.

## Trust boundaries

Treat these inputs as untrusted:

- Opened `.gamebook` archives, including their paths, JSON records, sizes, names, and compressed data.
- Imported image, video, caption, transcript, JSON, and CSV files.
- Export destinations that may already contain files.
- WebView requests for app-managed media.
- Future processor responses and credentials.

The WebView receives only narrowly scoped commands and opaque IDs. It never receives unrestricted filesystem permissions, archive source paths, workspace paths, or Windows credential values.

## Archive and import validation

Before extraction or materialization, Gamebook must:

- Normalize archive names as relative POSIX paths.
- Reject absolute paths, drive prefixes, `..`, NUL characters, alternate data streams, symlinks, hard links, reparse-point escapes, and case-insensitive duplicate destinations.
- Enforce declared and actual uncompressed sizes before writing.
- Limit manifest and individual JSON records to 16 MB, previews to 32 MB, and total entry count to 250,000.
- Compare projected materialization size with available disk space and the configured storage limit.
- Write through a newly created file handle inside the validated workspace rather than joining unchecked strings.
- Verify every content-addressed asset against SHA-256 before exposing it.

Import identifies content through native probing and decoding, not filename extension alone. Unsupported, malformed, encrypted, HDR/10-bit, or suspicious media is rejected before canonical records change. Parsing failure cannot delete or replace existing evidence.

## Media protocol

The frontend addresses local media with a 256-bit cryptographically random token tied to one application instance, workspace, asset digest, and allowed operation.

- Tokens contain no path or user-readable metadata.
- Tokens are never persisted in projects, settings, logs, exports, or crash reports.
- Tokens expire ten minutes after last access and immediately when the project closes, the asset is evicted, or the application exits.
- The protocol accepts only `GET` and `HEAD`, implements validated byte ranges, emits a trusted MIME type, and does not list directories.
- Invalid, expired, cross-workspace, malformed-range, or noncanonical requests return a generic failure without revealing paths.
- Protocol responses use restrictive CSP and origin rules. Only the app WebView may request project media.

Decoded-frame references follow the same token rules and are read-only. Token renewal verifies that the requesting page still holds the matching evidence reference.

## Workspace protection

Workspaces and staging files are created under the current user's Tauri application-data directory with access restricted to that user. Gamebook does not follow workspace symlinks or reparse points.

Unsaved workspaces, Project Trash, and interrupted recordings are not deleted automatically. Clean cache eviction is explicit or policy-driven and removes only verified recreatable materializations. Secure erasure is not promised on SSDs; documentation describes deletion as logical filesystem removal.

## Audio and capture privacy

Version 1 system audio uses whole-output-device WASAPI loopback. It may record notifications, communication applications, browser audio, music, and other games. Gamebook discloses this scope before the first audio-enabled recording and whenever the disclosure text materially changes.

Microphone capture is a separate setting, defaults off, and requires separate first-use consent. Changing devices, restoring settings, importing a project, or applying an update can never enable the microphone implicitly.

The recording HUD communicates video, system-audio, and microphone state independently. Capture metadata such as monitor name, window title, game/build labels, and device names can be omitted from export through privacy controls.

## Interrupted recording recovery

Recording writes only to a staging file plus journal until final probing succeeds. After interruption:

- A playable staged file may be recovered as explicitly labeled draft evidence.
- An unplayable file is quarantined with size and failure information.
- Neither state is added to a project automatically.
- The user may retry probing, reveal the quarantined file, or delete it.
- Diagnostic export excludes the media unless the user separately chooses to attach it.

Gamebook never silently deletes interrupted footage and never claims to repair it unless a tested native repair path is adopted.

## Diagnostics and telemetry

Version 1 writes local rotating diagnostic logs only. Defaults are five files of at most 10 MB each.

Logs may contain application version, operating-system version, coarse hardware capabilities, command/event names, durations, error classes, anonymized object counts, and hashed operation IDs. Logs must not contain:

- Media bytes, frames, thumbnails, audio, captions, transcripts, or annotation text.
- Project titles, note contents, tags, window titles, usernames, email addresses, credentials, opaque media tokens, or full filesystem paths.
- Raw archive records or imported filenames.

Diagnostic export shows the exact files and a redacted preview before creation. It is user initiated, produces a local ZIP, and never uploads automatically. Crash reporting remains local unless a future opt-in provider is separately specified.

## Export privacy

Exports are new independent copies that may contain playable media, personal notes, source metadata, captions, and transcripts. Before multimedia export, Gamebook summarizes included media count, audio presence, microphone presence, metadata fields, and estimated size.

Offline HTML exports make no network requests and include no analytics, remote fonts, remote scripts, tracking pixels, or provider SDKs. Privacy controls can omit device names, window titles, local paths, researcher identity, and hidden research metadata without altering source projects.

## Updates and rollback

Updates are never forced. Gamebook verifies signed release metadata and Authenticode before staging an installer. A failed download, verification, or installation leaves the installed version and projects unchanged.

The previous signed installer remains available until the new version passes first-launch health checks. Failure offers reinstall of that previous version. Project migration always preserves the pre-migration project backup, and an older application refuses unsupported newer project formats rather than attempting downgrade mutation.

Release metadata declares minimum supported and latest stable versions. Security-critical updates may display a persistent recommendation but still require user approval.

## Future cloud processors

Any future cloud processor requires:

- Provider identity, destination region, retention policy, model use policy, and cost disclosure.
- A preview of the exact selected media/text and metadata being sent.
- Per-operation consent and cancellation.
- Credentials stored in Windows Credential Manager.
- No reuse of diagnostic or update consent.
- A local-only alternative or clear explanation when none exists.

## Security acceptance

- Archive traversal, symlink/reparse, duplicate-name, decompression-bomb, malformed-range, expired-token, and cross-workspace tests fail closed.
- Logs and diagnostic bundles pass automated secret, path, token, and content-redaction tests.
- No network request occurs during capture, editing, save/open, recovery, or offline export.
- Microphone state remains off across defaults, migration, project open, update, and settings corruption unless the user enabled it explicitly.
- Interrupted media, Trash, cache eviction, and update rollback never alter the last valid saved project.
- Security and privacy behavior receives manual review before every signed release.
