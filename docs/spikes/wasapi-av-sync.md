# WASAPI Loopback And A/V Synchronization Spike

> Status: Isolated Milestone 2 feasibility harness for issue #7. This is not a production recording path or an accepted architecture decision.

## Purpose

The harness measures whole-output-device WASAPI loopback, Media Foundation AAC encoding, packet discontinuities, endpoint changes, cancellation, post-start audio failure, and drift against a simultaneous 60 FPS reference timeline. It does not add a Tauri command, recording UI, settings, project records, schema, or persistence behavior.

The implementation activates only the default `eRender`/`eMultimedia` endpoint in shared loopback mode. It has no microphone option and never activates an `eCapture` endpoint.

## Build And Run

Use an exact clean source revision for every report in one evidence set:

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --example wasapi_av_sync_spike --release

src-tauri\target\release\examples\wasapi_av_sync_spike.exe `
  --build-id COMMIT_SHA `
  --scenario active-audio `
  --duration 30 `
  --countdown 3 `
  --run-id active-audio-01
```

Available scenarios are:

- `active-audio`: plays a local looping 440 Hz fixture at low amplitude while capturing the default output-device mix. This scenario is audible and must not be run without the user's approval.
- `silence`: plays a local all-zero fixture so the audio engine continues producing packets without audible output.
- `cancel`: stops early, drops the unfinalized writer, and removes the partial MP4.
- `audio-failure`: uses the local all-zero fixture, stops audio after five seconds while the reference video clock continues for the requested duration, then finalizes the partial audio timeline.
- `endpoint-change`: uses the local all-zero fixture while polling the default render endpoint and requires an observed endpoint change. The harness never changes the Windows default itself; a user-approved manual switch is required.
- `encoder-failure`: deliberately gives the sink writer a directory as its output URL and verifies startup failure without retained media.

Reports and MP4s are written below `src-tauri/target/wasapi-av-sync-spike` by default. They are local evidence and must remain uncommitted.

## Timing Model

`IAudioCaptureClient::GetBuffer` reports packet device position and QPC position. Windows returns the packet QPC position in 100-nanosecond units. The harness also samples `QueryPerformanceCounter` for a simultaneous 60 FPS reference timeline.

The first audio packet is encoded at timestamp zero. Later sample times retain their QPC offsets, so packet gaps remain visible in the encoded timeline. A/V drift is the change between the initial and final audio-to-reference-clock offsets:

```text
drift = final audio/reference offset - initial audio/reference offset
```

This isolates clock drift from startup latency. The report records both offsets, audio timeline duration, reference duration, encoded duration, buffer duration, packet counts, silent frames, discontinuities, timestamp errors, and finalization time.

The WASAPI mix is converted to 16-bit PCM before Media Foundation AAC encoding. The harness accepts mono or stereo 44.1 kHz and 48 kHz PCM or float mix formats. Unsupported formats fail explicitly before capture.

## Evidence Contract

A complete evidence set uses one exact clean release build and includes:

- two 30-second controlled active-audio runs;
- two 30-second controlled silence runs;
- two cancellation-cleanup runs;
- one simulated post-start audio-failure run;
- one user-approved default-render-endpoint change run;
- one deliberate encoder-startup failure run.

Completed active, silence, and endpoint-change runs pass when:

- absolute A/V drift is at most 50 ms after 30 seconds;
- absolute encoded-duration error is no more than one reported WASAPI endpoint buffer;
- finalization completes within five seconds;
- the MP4 is non-empty and the report contains packet, audio-QPC, and reference-clock evidence;
- microphone capture and capture-endpoint activation are both false.

Cancellation and encoder failure must leave no retained MP4. The audio-failure run must prove that audio stops early while the reference clock continues through the requested duration.

Create a local manifest from `docs/spikes/wasapi-av-sync-evidence.example.json`, replace the build and report paths, then verify it:

```powershell
npm.cmd run wasapi-sync:verify -- --manifest path/to/wasapi-av-sync-evidence.json
```

Individual reports and verifier behavior can be checked with:

```powershell
npm.cmd run wasapi-sync:verify -- path/to/report.json --scenario active-audio
npm.cmd run wasapi-sync:verify -- --self-test
```

## Accessibility Contract For Production

The production workflow must disclose before first audio-enabled recording that system audio captures the complete selected output-device mix and may include notifications, voice chat, browsers, music, and other applications. Video, system-audio, and microphone states remain independent, textual, keyboard-operable, and announced without relying on color or motion. Microphone consent is separate and cannot be inferred from system-audio consent.

This isolated CLI has no interactive or shipped user interface. Keyboard navigation, focus, NVDA, High Contrast, reduced-motion, and scale checks therefore do not apply to the executable. Actual disclosure, HUD, recovery, and fallback surfaces remain Milestone 7 validation work.

## Security And Privacy

The harness uses local WASAPI and Media Foundation APIs only. It does not inject into games, read game memory, access a microphone, open network connections, write project records, or alter Windows privacy settings. Endpoint names and IDs, local paths, user identifiers, and audio bytes are excluded from reports. Environment probes report only audio-device status counts.

The controlled tone, silence fixture, encoded MP4s, and JSON reports remain local and uncommitted. The endpoint-change scenario never changes the default endpoint itself.

## Current Validation

The reference set used source revision `43d3f2d15338b75263f4e69985af5ce5b3e4baa1` and one clean release binary with SHA-256 `0FA775A6A61F8E49E9F04451B27637DCB0FAABBD04C3572E96FF8A811EB0EB8F`. The machine-verified local manifest contains nine independent reports from that exact build.

The reference system was Windows 11 Pro build 26200 on an Intel Core Ultra 9 285K with 24 cores and approximately 63.4 GiB of visible memory, healthy NTFS storage, eight healthy reported audio devices, and the Balanced power scheme. The default render mix was stereo 48 kHz float PCM. The harness converted it to PCM16 for AAC and reported a 4,800-frame, 100 ms shared endpoint buffer.

| Scenario | Reference duration | A/V drift | Encoded duration | Finalization | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Active audio 1 | 30,008.71 ms | -18.45 ms | -5.08 ms error | 2 ms | Passed |
| Active audio 2 | 30,000.03 ms | -9.34 ms | -4.67 ms error | 3 ms | Passed |
| Silence 1 | 30,003.00 ms | -22.28 ms | -4.62 ms error | 1 ms | Passed |
| Silence 2 | 30,004.38 ms | -14.09 ms | -5.04 ms error | 1 ms | Passed |
| Cancellation 1 | 5,170.66 ms | Not applicable | No output retained | Not applicable | Passed |
| Cancellation 2 | 5,110.06 ms | Not applicable | No output retained | Not applicable | Passed |
| Post-start audio failure | 30,007.00 ms | Not gated after intentional stop | 4,992.40 ms retained audio | 2 ms | Passed |
| Default endpoint change | 60,001.36 ms | -20.98 ms | -10.31 ms error | 1 ms | Passed |
| Encoder startup failure | Not started | Not applicable | No output retained | Not applicable | Passed |

All completed runs stayed below the 50 ms absolute drift gate, within the 100 ms endpoint-buffer duration gate, and below the five-second finalization gate. They recorded no timestamp errors. Each completed run reported one initial discontinuity packet. The post-start failure retained 4,990.40 ms of audio while the shared reference clock continued for 30,007.00 ms. The manually initiated default-render change was observed without the harness modifying the setting. Microphone capture and capture-endpoint activation remained false in every report; cancellation and encoder startup failure left no retained output.

Targeted formatting, Clippy with warnings denied, four focused Rust tests, JavaScript syntax validation, verifier self-tests, and the complete local evidence-manifest verification pass. The result supports direct WASAPI shared loopback, Media Foundation AAC, and a shared QPC timing basis for issue #9 and the Milestone 5 audio decision. It does not select the complete capture stack or create an accepted ADR before the remaining Milestone 2 gates and architecture freeze.
