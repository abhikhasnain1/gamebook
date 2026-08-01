#![cfg(target_os = "windows")]

use std::{
    env,
    error::Error,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use windows_capture::{
    capture::{Context, GraphicsCaptureApiHandler},
    encoder::{
        AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
        VideoSettingsSubType,
    },
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    graphics_capture_picker::GraphicsCapturePicker,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
    window::Window,
};

type SpikeError = Box<dyn Error + Send + Sync>;

#[derive(Clone)]
struct RunConfig {
    scenario: Scenario,
    build_id: String,
    declared_target_kind: &'static str,
    target_label: String,
    source_width: u32,
    source_height: u32,
    width: u32,
    height: u32,
    frame_rate: u32,
    duration: Duration,
    output_path: PathBuf,
    report_path: PathBuf,
    started_at: String,
    args: Vec<String>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Scenario {
    Encode,
    Cancel,
    SourceClose,
    EncoderFailure,
    EncoderCapability,
}

const CAPABILITY_PROFILES: [EncoderProfile; 4] = [
    EncoderProfile::new(3840, 2160, 60),
    EncoderProfile::new(3840, 2160, 30),
    EncoderProfile::new(2560, 1440, 60),
    EncoderProfile::new(1920, 1080, 60),
];

const CONTROLLED_FIXTURE_WINDOW_TITLE: &str = "Gamebook Native Capture Fixture - Brave";

struct CaptureRun {
    config: RunConfig,
    encoder: Option<VideoEncoder>,
    wall_start: Instant,
    first_timestamp_ticks: Option<i64>,
    last_timestamp_ticks: Option<i64>,
    previous_timestamp_ticks: Option<i64>,
    submitted_frames: u64,
    duplicate_timestamps: u64,
    backwards_timestamps: u64,
    largest_gap_ticks: i64,
    estimated_dropped_frames: u64,
    report_written: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpikeReport {
    schema: &'static str,
    started_at: String,
    completed_at: String,
    command: Vec<String>,
    scenario: Scenario,
    declared_target_kind: &'static str,
    target_label: String,
    source_width: u32,
    source_height: u32,
    requested_width: u32,
    requested_height: u32,
    requested_frame_rate: u32,
    requested_duration_ms: u128,
    output_path: String,
    output_bytes: Option<u64>,
    submitted_frames: u64,
    estimated_frame_duration_ms: f64,
    first_timestamp_ticks: Option<i64>,
    last_timestamp_ticks: Option<i64>,
    capture_timestamp_span_ms: Option<f64>,
    output_duration_ms: Option<f64>,
    duration_error_ms: Option<f64>,
    largest_frame_gap_ms: f64,
    estimated_dropped_frames: u64,
    duplicate_timestamps: u64,
    backwards_timestamps: u64,
    finalization_ms: Option<u128>,
    cancelled: bool,
    cleaned_partial_output: bool,
    result: &'static str,
    error_message: Option<String>,
    environment: EnvironmentReport,
    notes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentReport {
    application_build: ApplicationBuild,
    exe: String,
    current_dir: String,
    os: &'static str,
    arch: &'static str,
    family: &'static str,
    windows_capture_version: &'static str,
    probes: Vec<EnvironmentProbe>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationBuild {
    name: &'static str,
    version: &'static str,
    source_revision: String,
    profile: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncoderProfile {
    width: u32,
    height: u32,
    frame_rate: u32,
}

impl EncoderProfile {
    const fn new(width: u32, height: u32, frame_rate: u32) -> Self {
        Self {
            width,
            height,
            frame_rate,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EncoderCapabilityReport {
    schema: &'static str,
    started_at: String,
    completed_at: String,
    command: Vec<String>,
    codec: &'static str,
    capability_scope: &'static str,
    capture_started: bool,
    synthetic_frames_only: bool,
    four_k_60_supported: bool,
    fallback_required: bool,
    selected_profile: Option<EncoderProfile>,
    result: &'static str,
    attempts: Vec<EncoderCapabilityAttempt>,
    environment: EnvironmentReport,
    notes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EncoderCapabilityAttempt {
    profile: EncoderProfile,
    output_path: String,
    initialization_ms: u128,
    finalization_ms: Option<u128>,
    frames_submitted: u64,
    frame_bytes: u64,
    output_bytes: Option<u64>,
    cleaned_output: bool,
    result: &'static str,
    error_message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentProbe {
    name: &'static str,
    command: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl GraphicsCaptureApiHandler for CaptureRun {
    type Flags = RunConfig;
    type Error = SpikeError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let config = ctx.flags;
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(config.width, config.height)
                .sub_type(VideoSettingsSubType::H264)
                .frame_rate(config.frame_rate),
            AudioSettingsBuilder::new().disabled(true),
            ContainerSettingsBuilder::new(),
            &config.output_path,
        )?;

        Ok(Self {
            config,
            encoder: Some(encoder),
            wall_start: Instant::now(),
            first_timestamp_ticks: None,
            last_timestamp_ticks: None,
            previous_timestamp_ticks: None,
            submitted_frames: 0,
            duplicate_timestamps: 0,
            backwards_timestamps: 0,
            largest_gap_ticks: 0,
            estimated_dropped_frames: 0,
            report_written: false,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let timestamp_ticks = frame.timestamp()?.Duration;
        if self.first_timestamp_ticks.is_none() {
            self.first_timestamp_ticks = Some(timestamp_ticks);
        }
        if let Some(previous) = self.previous_timestamp_ticks {
            let gap = timestamp_ticks - previous;
            if gap == 0 {
                self.duplicate_timestamps += 1;
            } else if gap < 0 {
                self.backwards_timestamps += 1;
            } else {
                self.largest_gap_ticks = self.largest_gap_ticks.max(gap);
                let expected_gap_ticks = 10_000_000 / i64::from(self.config.frame_rate);
                let estimated_intervals =
                    ((gap + expected_gap_ticks / 2) / expected_gap_ticks).max(1);
                self.estimated_dropped_frames += (estimated_intervals - 1) as u64;
            }
        }
        self.previous_timestamp_ticks = Some(timestamp_ticks);
        self.last_timestamp_ticks = Some(timestamp_ticks);

        let elapsed = self.wall_start.elapsed();
        let should_cancel =
            matches!(self.config.scenario, Scenario::Cancel) && elapsed >= self.config.duration;

        if should_cancel {
            self.encoder.take();
            let cleaned = ensure_output_absent(&self.config.output_path)?;
            self.write_report(None, true, cleaned, "cancelled")?;
            capture_control.stop();
            return Ok(());
        }

        let source_close_timed_out = matches!(self.config.scenario, Scenario::SourceClose)
            && elapsed >= self.config.duration;
        if source_close_timed_out {
            self.encoder.take();
            let cleaned = ensure_output_absent(&self.config.output_path)?;
            self.write_report(None, false, cleaned, "source-not-closed")?;
            capture_control.stop();
            return Ok(());
        }

        if let Some(encoder) = self.encoder.as_mut() {
            encoder.send_frame(frame)?;
            self.submitted_frames += 1;
        }

        print!(
            "\r{} frames, {:.1}s",
            self.submitted_frames,
            elapsed.as_secs_f64()
        );
        std::io::stdout().flush()?;

        if elapsed >= self.config.duration {
            let started = Instant::now();
            if let Some(encoder) = self.encoder.take() {
                encoder.finish()?;
            }
            let finalization_ms = started.elapsed().as_millis();
            println!();
            self.write_report(Some(finalization_ms), false, false, "completed")?;
            capture_control.stop();
        }

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if !self.report_written {
            self.encoder.take();
            let result = if matches!(self.config.scenario, Scenario::SourceClose) {
                "source-closed"
            } else {
                "unexpected-source-closed"
            };
            self.write_report(
                None,
                false,
                ensure_output_absent(&self.config.output_path)?,
                result,
            )?;
        }
        Ok(())
    }
}

impl CaptureRun {
    fn write_report(
        &mut self,
        finalization_ms: Option<u128>,
        cancelled: bool,
        cleaned_partial_output: bool,
        result: &'static str,
    ) -> Result<(), SpikeError> {
        if self.report_written {
            return Ok(());
        }

        let output_bytes = file_bytes(&self.config.output_path);
        let capture_timestamp_span_ms =
            match (self.first_timestamp_ticks, self.last_timestamp_ticks) {
                (Some(first), Some(last)) if last >= first => Some(ticks_to_ms(last - first)),
                _ => None,
            };
        let output_duration_ms =
            finalization_ms.and_then(|_| probe_output_duration_ms(&self.config.output_path));
        let requested_duration_ms = self.config.duration.as_millis();
        let duration_error_ms =
            output_duration_ms.map(|actual| actual - requested_duration_ms as f64);
        let estimated_frame_duration_ms = 1000.0 / self.config.frame_rate as f64;

        let report = SpikeReport {
            schema: "gamebook.native-capture-spike.v1",
            started_at: self.config.started_at.clone(),
            completed_at: unix_time_label(),
            command: sanitize_command(&self.config.args),
            scenario: self.config.scenario,
            declared_target_kind: self.config.declared_target_kind,
            target_label: self.config.target_label.clone(),
            source_width: self.config.source_width,
            source_height: self.config.source_height,
            requested_width: self.config.width,
            requested_height: self.config.height,
            requested_frame_rate: self.config.frame_rate,
            requested_duration_ms,
            output_path: artifact_label(&self.config.output_path),
            output_bytes,
            submitted_frames: self.submitted_frames,
            estimated_frame_duration_ms,
            first_timestamp_ticks: self.first_timestamp_ticks,
            last_timestamp_ticks: self.last_timestamp_ticks,
            capture_timestamp_span_ms,
            output_duration_ms,
            duration_error_ms,
            largest_frame_gap_ms: ticks_to_ms(self.largest_gap_ticks),
            estimated_dropped_frames: self.estimated_dropped_frames,
            duplicate_timestamps: self.duplicate_timestamps,
            backwards_timestamps: self.backwards_timestamps,
            finalization_ms,
            cancelled,
            cleaned_partial_output,
            result,
            error_message: None,
            environment: EnvironmentReport::current(&self.config.build_id)?,
            notes: vec![
                "Audio is disabled in this harness; WASAPI loopback is covered by the dependent audio synchronization spike.".to_string(),
                "The harness writes to a staging output path and removes cancellation/source-close partial output.".to_string(),
                "Output duration is read from the finalized MP4 through the Windows System.Media.Duration property; capture timestamp span is reported separately.".to_string(),
                "The production application is not linked to this example and exposes no recording UI from this spike.".to_string(),
            ],
        };

        if let Some(parent) = self.config.report_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(
            &self.config.report_path,
            serde_json::to_string_pretty(&report)?,
        )?;
        self.report_written = true;
        println!("Report: {}", self.config.report_path.display());
        Ok(())
    }
}

impl EnvironmentReport {
    fn current(build_id: &str) -> Result<Self, SpikeError> {
        Ok(Self {
            application_build: ApplicationBuild {
                name: env!("CARGO_PKG_NAME"),
                version: env!("CARGO_PKG_VERSION"),
                source_revision: build_id.to_string(),
                profile: if cfg!(debug_assertions) {
                    "debug"
                } else {
                    "release"
                },
            },
            exe: env::current_exe()?
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("native_capture_spike.exe")
                .to_string(),
            current_dir: ".".to_string(),
            os: env::consts::OS,
            arch: env::consts::ARCH,
            family: env::consts::FAMILY,
            windows_capture_version: "2.0.0",
            probes: vec![
                powershell_probe(
                    "windows-os-memory",
                    "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture,TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress",
                ),
                powershell_probe(
                    "cpu",
                    "Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed | ConvertTo-Json -Compress",
                ),
                powershell_probe(
                    "gpu-display-driver",
                    "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate | ConvertTo-Json -Compress",
                ),
                powershell_probe(
                    "audio-devices",
                    "$devices = @(Get-CimInstance Win32_SoundDevice); $statuses = @($devices | Group-Object Status | ForEach-Object { [pscustomobject]@{ Status = $_.Name; Count = $_.Count } }); [pscustomobject]@{ Count = $devices.Count; Statuses = $statuses } | ConvertTo-Json -Compress -Depth 4",
                ),
                powershell_probe(
                    "storage-volumes",
                    "Get-Volume | Select-Object FileSystemType,Size,SizeRemaining,HealthStatus | ConvertTo-Json -Compress",
                ),
                powershell_probe(
                    "webview2-runtime",
                    "$paths = 'HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}','HKLM:\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}','HKLM:\\Software\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'; $paths | ForEach-Object { Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue | Select-Object name,pv } | ConvertTo-Json -Compress",
                ),
                command_probe("power-scheme", "powercfg.exe", &["/GETACTIVESCHEME"]),
            ],
        })
    }
}

fn run_encoder_capability(options: Options) -> Result<(), SpikeError> {
    let started_at = unix_time_label();
    let mut attempts = Vec::with_capacity(CAPABILITY_PROFILES.len());

    for profile in CAPABILITY_PROFILES {
        attempts.push(attempt_encoder_profile(&options, profile)?);
    }

    let selected_profile = attempts
        .iter()
        .find(|attempt| attempt.result == "supported")
        .map(|attempt| attempt.profile);
    let four_k_60_supported = attempts
        .first()
        .is_some_and(|attempt| attempt.result == "supported");
    let report = EncoderCapabilityReport {
        schema: "gamebook.native-encoder-capability.v1",
        started_at,
        completed_at: unix_time_label(),
        command: sanitize_command(&options.args),
        codec: "h264",
        capability_scope: "synthetic-two-frame-initialization-and-finalization",
        capture_started: false,
        synthetic_frames_only: true,
        four_k_60_supported,
        fallback_required: !four_k_60_supported,
        selected_profile,
        result: if selected_profile.is_some() {
            "supported"
        } else {
            "unsupported"
        },
        attempts,
        environment: EnvironmentReport::current(&options.build_id)?,
        notes: vec![
            "This capability-only scenario does not construct or start Windows Graphics Capture and never reads screen pixels.".to_string(),
            "Each profile must initialize H.264, accept two deterministic BGRA frames, finalize a non-empty MP4, and remove the MP4 before it is reported as supported.".to_string(),
            "The result proves encoder profile initialization and finalization on this stack; it does not prove sustained capture throughput or frame pacing.".to_string(),
        ],
    };
    let report_path = options.output_dir.join(format!("{}.json", options.run_id));
    fs::write(&report_path, serde_json::to_string_pretty(&report)?)?;
    println!("Report: {}", report_path.display());
    Ok(())
}

fn attempt_encoder_profile(
    options: &Options,
    profile: EncoderProfile,
) -> Result<EncoderCapabilityAttempt, SpikeError> {
    let output_path = options.output_dir.join(format!(
        "{}-{}x{}-{}.mp4",
        options.run_id, profile.width, profile.height, profile.frame_rate
    ));
    ensure_output_absent(&output_path)?;

    let frame_bytes = capability_frame_bytes(profile)?;
    let mut frame = vec![0_u8; usize::try_from(frame_bytes)?];
    let initialization_started = Instant::now();
    let encoder = VideoEncoder::new(
        VideoSettingsBuilder::new(profile.width, profile.height)
            .sub_type(VideoSettingsSubType::H264)
            .frame_rate(profile.frame_rate),
        AudioSettingsBuilder::new().disabled(true),
        ContainerSettingsBuilder::new(),
        &output_path,
    );
    let initialization_ms = initialization_started.elapsed().as_millis();

    let mut finalization_ms = None;
    let mut frames_submitted = 0;
    let mut error_message = None;
    let result = match encoder {
        Ok(mut encoder) => {
            let frame_duration_ticks = 10_000_000 / i64::from(profile.frame_rate);
            let last_byte = frame.len() - 1;
            for frame_index in 0..2_i64 {
                frame[0] = u8::try_from(frame_index + 1)?;
                frame[last_byte] = u8::try_from(frame_index + 1)?;
                match encoder.send_frame_buffer(&frame, frame_index * frame_duration_ticks) {
                    Ok(()) => frames_submitted += 1,
                    Err(error) => {
                        error_message =
                            Some(sanitize_capability_error(&error.to_string(), &output_path));
                        break;
                    }
                }
            }

            if error_message.is_none() {
                let finalization_started = Instant::now();
                match encoder.finish() {
                    Ok(()) => {
                        finalization_ms = Some(finalization_started.elapsed().as_millis());
                        "supported"
                    }
                    Err(error) => {
                        finalization_ms = Some(finalization_started.elapsed().as_millis());
                        error_message =
                            Some(sanitize_capability_error(&error.to_string(), &output_path));
                        "unsupported"
                    }
                }
            } else {
                drop(encoder);
                "unsupported"
            }
        }
        Err(error) => {
            error_message = Some(sanitize_capability_error(&error.to_string(), &output_path));
            "unsupported"
        }
    };

    let output_bytes = file_bytes(&output_path);
    let cleaned_output = ensure_output_absent(&output_path)?;
    let final_result = if result == "supported" && output_bytes.unwrap_or(0) > 0 {
        "supported"
    } else {
        if result == "supported" {
            error_message = Some("Encoder finalized without a non-empty MP4 artifact.".to_string());
        }
        "unsupported"
    };

    Ok(EncoderCapabilityAttempt {
        profile,
        output_path: artifact_label(&output_path),
        initialization_ms,
        finalization_ms,
        frames_submitted,
        frame_bytes,
        output_bytes,
        cleaned_output,
        result: final_result,
        error_message,
    })
}

fn capability_frame_bytes(profile: EncoderProfile) -> Result<u64, SpikeError> {
    u64::from(profile.width)
        .checked_mul(u64::from(profile.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Capability frame size overflowed.".into())
}

fn sanitize_capability_error(error_message: &str, output_path: &Path) -> String {
    let mut candidates = vec![output_path.display().to_string()];
    if let Ok(current_dir) = env::current_dir() {
        candidates.push(current_dir.display().to_string());
    }
    sanitize_paths(error_message, &candidates)
}

fn main() -> Result<(), SpikeError> {
    let options = Options::parse(env::args().collect())?;
    fs::create_dir_all(&options.output_dir)?;

    if matches!(options.scenario, Scenario::EncoderCapability) {
        return run_encoder_capability(options);
    }

    match options.target {
        TargetOption::PrimaryMonitor => {
            let monitor = Monitor::primary()?;
            let width = monitor.width()?;
            let height = monitor.height()?;
            let label = "primary-monitor".to_string();
            run_capture(monitor, width, height, "monitor", label, options)
        }
        TargetOption::MonitorIndex(index) => {
            let monitor = Monitor::from_index(index)?;
            let width = monitor.width()?;
            let height = monitor.height()?;
            let label = format!("monitor-index-{index}");
            run_capture(monitor, width, height, "monitor", label, options)
        }
        TargetOption::ControlledFixtureWindow => {
            let window = Window::from_name(CONTROLLED_FIXTURE_WINDOW_TITLE)?;
            let width = u32::try_from(window.width()?)?;
            let height = u32::try_from(window.height()?)?;
            run_capture(
                window,
                width,
                height,
                "window",
                "controlled-fixture-window".to_string(),
                options,
            )
        }
        TargetOption::Picker(declared_kind) => {
            let Some(item) = GraphicsCapturePicker::pick_item()? else {
                println!("No capture target selected.");
                return Ok(());
            };
            let (width, height) = item.size()?;
            let label = declared_kind.target_label().to_string();
            run_capture(
                item,
                width as u32,
                height as u32,
                declared_kind.report_value(),
                label,
                options,
            )
        }
    }
}

fn run_capture<T>(
    target: T,
    source_width: u32,
    source_height: u32,
    declared_target_kind: &'static str,
    target_label: String,
    options: Options,
) -> Result<(), SpikeError>
where
    T: TryInto<GraphicsCaptureItemType>,
{
    run_countdown(options.countdown_seconds)?;
    let width = even_dimension(source_width);
    let height = even_dimension(source_height);
    let output_path = if matches!(options.scenario, Scenario::EncoderFailure) {
        options.output_dir.clone()
    } else {
        options.output_dir.join(format!("{}.mp4", options.run_id))
    };
    let report_path = options.output_dir.join(format!("{}.json", options.run_id));

    if width != source_width || height != source_height {
        println!(
            "Padding requested for encoder compatibility: {}x{} -> {}x{}",
            source_width, source_height, width, height
        );
    }

    let config = RunConfig {
        scenario: options.scenario,
        build_id: options.build_id,
        declared_target_kind,
        target_label,
        source_width,
        source_height,
        width,
        height,
        frame_rate: options.frame_rate,
        duration: Duration::from_secs(options.duration_seconds),
        output_path,
        report_path,
        started_at: unix_time_label(),
        args: options.args,
    };

    let settings = Settings::new(
        target,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Exclude,
        minimum_update_interval(options.frame_rate),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        config.clone(),
    );

    match CaptureRun::start(settings) {
        Ok(()) => Ok(()),
        Err(error) => {
            write_startup_failure_report(&config, &error.to_string())?;
            if matches!(config.scenario, Scenario::EncoderFailure) {
                Ok(())
            } else {
                Err(format!("Capture failed before a completion report: {error}").into())
            }
        }
    }
}

#[derive(Clone)]
struct Options {
    target: TargetOption,
    scenario: Scenario,
    build_id: String,
    duration_seconds: u64,
    frame_rate: u32,
    countdown_seconds: u64,
    output_dir: PathBuf,
    run_id: String,
    args: Vec<String>,
}

#[derive(Clone, Copy)]
enum TargetOption {
    PrimaryMonitor,
    MonitorIndex(usize),
    ControlledFixtureWindow,
    Picker(PickerTargetKind),
}

#[derive(Clone, Copy)]
enum PickerTargetKind {
    Unspecified,
    Window,
    Monitor,
}

impl PickerTargetKind {
    fn report_value(self) -> &'static str {
        match self {
            Self::Unspecified => "unspecified",
            Self::Window => "window",
            Self::Monitor => "monitor",
        }
    }

    fn target_label(self) -> &'static str {
        match self {
            Self::Unspecified => "picker-selected-unspecified",
            Self::Window => "picker-selected-window",
            Self::Monitor => "picker-selected-monitor",
        }
    }
}

impl Options {
    fn parse(args: Vec<String>) -> Result<Self, SpikeError> {
        let mut target = TargetOption::PrimaryMonitor;
        let mut scenario = Scenario::Encode;
        let mut build_id = None;
        let mut duration_seconds = 30;
        let mut frame_rate = 60;
        let mut countdown_seconds = 0;
        let mut output_dir = PathBuf::from("src-tauri/target/native-capture-spike");
        let mut run_id = format!("capture-{}", unix_seconds());

        let mut index = 1;
        while index < args.len() {
            match args[index].as_str() {
                "--target" => {
                    index += 1;
                    let value = args.get(index).ok_or("--target requires a value")?;
                    target = parse_target(value)?;
                }
                "--scenario" => {
                    index += 1;
                    let value = args.get(index).ok_or("--scenario requires a value")?;
                    scenario =
                        match value.as_str() {
                            "encode" => Scenario::Encode,
                            "cancel" => Scenario::Cancel,
                            "source-close" => Scenario::SourceClose,
                            "encoder-failure" => Scenario::EncoderFailure,
                            "encoder-capability" => Scenario::EncoderCapability,
                            _ => return Err(
                                "scenario must be encode, cancel, source-close, encoder-failure, or encoder-capability".into(),
                            ),
                        };
                }
                "--build-id" => {
                    index += 1;
                    build_id = Some(validate_build_id(
                        args.get(index).ok_or("--build-id requires a value")?,
                    )?);
                }
                "--duration" => {
                    index += 1;
                    duration_seconds = args
                        .get(index)
                        .ok_or("--duration requires seconds")?
                        .parse()?;
                    if !(1..=300).contains(&duration_seconds) {
                        return Err("--duration must be between 1 and 300 seconds".into());
                    }
                }
                "--frame-rate" => {
                    index += 1;
                    frame_rate = args
                        .get(index)
                        .ok_or("--frame-rate requires 30 or 60")?
                        .parse()?;
                    if !matches!(frame_rate, 30 | 60) {
                        return Err("--frame-rate must be 30 or 60".into());
                    }
                }
                "--countdown" => {
                    index += 1;
                    countdown_seconds = args
                        .get(index)
                        .ok_or("--countdown requires seconds")?
                        .parse()?;
                    if countdown_seconds > 30 {
                        return Err("--countdown must be between 0 and 30 seconds".into());
                    }
                }
                "--output-dir" => {
                    index += 1;
                    output_dir =
                        PathBuf::from(args.get(index).ok_or("--output-dir requires a path")?);
                }
                "--run-id" => {
                    index += 1;
                    run_id = validate_run_id(args.get(index).ok_or("--run-id requires a value")?)?;
                }
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                value => return Err(format!("Unknown option: {value}").into()),
            }
            index += 1;
        }

        let build_id = build_id.ok_or(
            "--build-id is required and must identify the exact committed source revision",
        )?;

        Ok(Self {
            target,
            scenario,
            build_id,
            duration_seconds,
            frame_rate,
            countdown_seconds,
            output_dir,
            run_id,
            args,
        })
    }
}

fn parse_target(value: &str) -> Result<TargetOption, SpikeError> {
    if value == "primary-monitor" {
        return Ok(TargetOption::PrimaryMonitor);
    }
    if value == "picker" {
        return Ok(TargetOption::Picker(PickerTargetKind::Unspecified));
    }
    if value == "picker-window" {
        return Ok(TargetOption::Picker(PickerTargetKind::Window));
    }
    if value == "picker-monitor" {
        return Ok(TargetOption::Picker(PickerTargetKind::Monitor));
    }
    if value == "controlled-fixture-window" {
        return Ok(TargetOption::ControlledFixtureWindow);
    }
    if let Some(index) = value.strip_prefix("monitor-index:") {
        return Ok(TargetOption::MonitorIndex(index.parse()?));
    }
    Err(
        "--target must be primary-monitor, controlled-fixture-window, picker, picker-window, picker-monitor, or monitor-index:N".into(),
    )
}

fn print_help() {
    println!(
        "Native capture spike\n\n\
         cargo run --manifest-path src-tauri/Cargo.toml --example native_capture_spike -- \\\n\
           --build-id COMMIT_SHA --target primary-monitor --scenario encode --duration 30 --frame-rate 60 --countdown 5\n\n\
         Targets: primary-monitor, monitor-index:N, controlled-fixture-window, picker-window, picker-monitor, picker\n\
         Scenarios: encode, cancel, source-close, encoder-failure, encoder-capability\n\
         Outputs: MP4 and JSON report under src-tauri/target/native-capture-spike by default"
    );
}

fn write_startup_failure_report(config: &RunConfig, error_message: &str) -> Result<(), SpikeError> {
    let report = SpikeReport {
        schema: "gamebook.native-capture-spike.v1",
        started_at: config.started_at.clone(),
        completed_at: unix_time_label(),
        command: sanitize_command(&config.args),
        scenario: config.scenario,
        declared_target_kind: config.declared_target_kind,
        target_label: config.target_label.clone(),
        source_width: config.source_width,
        source_height: config.source_height,
        requested_width: config.width,
        requested_height: config.height,
        requested_frame_rate: config.frame_rate,
        requested_duration_ms: config.duration.as_millis(),
        output_path: artifact_label(&config.output_path),
        output_bytes: file_bytes(&config.output_path),
        submitted_frames: 0,
        estimated_frame_duration_ms: 1000.0 / config.frame_rate as f64,
        first_timestamp_ticks: None,
        last_timestamp_ticks: None,
        capture_timestamp_span_ms: None,
        output_duration_ms: None,
        duration_error_ms: None,
        largest_frame_gap_ms: 0.0,
        estimated_dropped_frames: 0,
        duplicate_timestamps: 0,
        backwards_timestamps: 0,
        finalization_ms: None,
        cancelled: false,
        cleaned_partial_output: false,
        result: "startup-failed",
        error_message: Some(sanitize_error_message(error_message, config)),
        environment: EnvironmentReport::current(&config.build_id)?,
        notes: vec![
            "Startup failure reports exercise capture or encoder initialization failure before a project can reference media.".to_string(),
            "The encoder-failure scenario deliberately points the encoder at the output directory path to force initialization failure.".to_string(),
        ],
    };

    if let Some(parent) = config.report_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&config.report_path, serde_json::to_string_pretty(&report)?)?;
    println!("Report: {}", config.report_path.display());
    Ok(())
}

fn powershell_probe(name: &'static str, script: &str) -> EnvironmentProbe {
    command_probe(name, "powershell.exe", &["-NoProfile", "-Command", script])
}

fn command_probe(name: &'static str, program: &str, args: &[&str]) -> EnvironmentProbe {
    let command = if args.is_empty() {
        program.to_string()
    } else {
        format!("{program} {}", args.join(" "))
    };

    match Command::new(program).args(args).output() {
        Ok(output) => EnvironmentProbe {
            name,
            command,
            exit_code: output.status.code(),
            stdout: bounded_text(&String::from_utf8_lossy(&output.stdout)),
            stderr: bounded_text(&String::from_utf8_lossy(&output.stderr)),
        },
        Err(error) => EnvironmentProbe {
            name,
            command,
            exit_code: None,
            stdout: String::new(),
            stderr: error.to_string(),
        },
    }
}

fn bounded_text(value: &str) -> String {
    const LIMIT: usize = 12_000;
    if value.len() <= LIMIT {
        return value.trim().to_string();
    }
    format!("{}...<truncated>", &value[..LIMIT])
}

fn sanitize_command(args: &[String]) -> Vec<String> {
    let mut sanitized = args.to_vec();
    if let Some(program) = sanitized.first_mut() {
        if let Some(file_name) = PathBuf::from(&program)
            .file_name()
            .and_then(|value| value.to_str())
        {
            *program = file_name.to_string();
        }
    }

    let mut index = 0;
    while index < sanitized.len() {
        if sanitized[index] == "--output-dir" && index + 1 < sanitized.len() {
            sanitized[index + 1] = ".".to_string();
            index += 2;
        } else {
            index += 1;
        }
    }
    sanitized
}

fn validate_run_id(value: &str) -> Result<String, SpikeError> {
    let valid_length = !value.is_empty() && value.len() <= 80;
    let valid_characters = value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if !valid_length || !valid_characters {
        return Err(
            "--run-id must contain 1-80 ASCII letters, numbers, hyphens, or underscores".into(),
        );
    }
    Ok(value.to_string())
}

fn validate_build_id(value: &str) -> Result<String, SpikeError> {
    let valid_length = (7..=64).contains(&value.len());
    let valid_characters = value.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid_length || !valid_characters {
        return Err("--build-id must be a 7-64 character hexadecimal commit ID".into());
    }
    Ok(value.to_ascii_lowercase())
}

fn run_countdown(seconds: u64) -> Result<(), SpikeError> {
    for remaining in (1..=seconds).rev() {
        print!("\rCapture starts in {remaining}s ");
        std::io::stdout().flush()?;
        thread::sleep(Duration::from_secs(1));
    }
    if seconds > 0 {
        println!("\rCapture starting now.       ");
    }
    Ok(())
}

fn artifact_label(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| format!("artifact:{value}"))
        .unwrap_or_else(|| "artifact".to_string())
}

fn sanitize_error_message(error_message: &str, config: &RunConfig) -> String {
    let mut candidates = vec![
        config.output_path.display().to_string(),
        config.report_path.display().to_string(),
    ];
    if let Ok(current_dir) = env::current_dir() {
        candidates.push(current_dir.display().to_string());
    }

    sanitize_paths(error_message, &candidates)
}

fn sanitize_paths(value: &str, candidates: &[String]) -> String {
    let mut sanitized = value.to_string();
    for candidate in candidates {
        if candidate.is_empty() {
            continue;
        }
        sanitized = sanitized.replace(candidate, "<local-path>");
        sanitized = sanitized.replace(&candidate.replace('\\', "/"), "<local-path>");
    }
    sanitized
}

fn frame_interval(frame_rate: u32) -> Duration {
    Duration::from_nanos(1_000_000_000 / frame_rate as u64)
}

fn minimum_update_interval(frame_rate: u32) -> MinimumUpdateIntervalSettings {
    if frame_rate == 60 {
        MinimumUpdateIntervalSettings::Default
    } else {
        MinimumUpdateIntervalSettings::Custom(frame_interval(frame_rate))
    }
}

fn even_dimension(value: u32) -> u32 {
    value + (value % 2)
}

fn ticks_to_ms(ticks: i64) -> f64 {
    ticks as f64 / 10_000.0
}

fn file_bytes(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .filter(|value| value.is_file())
        .map(|value| value.len())
}

fn probe_output_duration_ms(path: &Path) -> Option<f64> {
    if !path.is_file() {
        return None;
    }

    let script = concat!(
        "$path = [IO.Path]::GetFullPath($env:GAMEBOOK_SPIKE_MEDIA_PATH); ",
        "$shell = New-Object -ComObject Shell.Application; ",
        "$folder = $shell.Namespace([IO.Path]::GetDirectoryName($path)); ",
        "$item = $folder.ParseName([IO.Path]::GetFileName($path)); ",
        "$duration = $item.ExtendedProperty('System.Media.Duration'); ",
        "if ($null -eq $duration) { exit 2 }; ",
        "[Console]::Write([string]$duration)"
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", script])
        .env("GAMEBOOK_SPIKE_MEDIA_PATH", path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let duration_ticks = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()?;
    Some(duration_ticks / 10_000.0)
}

fn ensure_output_absent(path: &Path) -> Result<bool, SpikeError> {
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(!path.exists())
}

fn unix_time_label() -> String {
    format!("unix-ms-{}", unix_millis())
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::{
        artifact_label, capability_frame_bytes, even_dimension, frame_interval,
        minimum_update_interval, parse_target, sanitize_command, validate_build_id,
        validate_run_id, EncoderProfile, Options, PickerTargetKind, Scenario, TargetOption,
        CAPABILITY_PROFILES,
    };
    use std::time::Duration;
    use windows_capture::settings::MinimumUpdateIntervalSettings;

    #[test]
    fn pads_only_odd_encoder_dimensions() {
        assert_eq!(even_dimension(1920), 1920);
        assert_eq!(even_dimension(1439), 1440);
    }

    #[test]
    fn maps_capture_frame_rate_to_minimum_interval() {
        assert_eq!(frame_interval(60).as_nanos(), 16_666_666);
        assert_eq!(frame_interval(30).as_nanos(), 33_333_333);
        assert_eq!(
            minimum_update_interval(60),
            MinimumUpdateIntervalSettings::Default
        );
        assert_eq!(
            minimum_update_interval(30),
            MinimumUpdateIntervalSettings::Custom(Duration::from_nanos(33_333_333))
        );
    }

    #[test]
    fn parses_supported_targets() {
        assert!(matches!(
            parse_target("primary-monitor").unwrap(),
            TargetOption::PrimaryMonitor
        ));
        assert!(matches!(
            parse_target("picker").unwrap(),
            TargetOption::Picker(PickerTargetKind::Unspecified)
        ));
        assert!(matches!(
            parse_target("picker-window").unwrap(),
            TargetOption::Picker(PickerTargetKind::Window)
        ));
        assert!(matches!(
            parse_target("picker-monitor").unwrap(),
            TargetOption::Picker(PickerTargetKind::Monitor)
        ));
        assert!(matches!(
            parse_target("monitor-index:2").unwrap(),
            TargetOption::MonitorIndex(2)
        ));
        assert!(matches!(
            parse_target("controlled-fixture-window").unwrap(),
            TargetOption::ControlledFixtureWindow
        ));
        assert!(parse_target("window").is_err());
    }

    #[test]
    fn parses_encoder_failure_scenario() {
        let options = Options::parse(vec![
            "native_capture_spike".to_string(),
            "--scenario".to_string(),
            "encoder-failure".to_string(),
            "--build-id".to_string(),
            "a73e733".to_string(),
            "--run-id".to_string(),
            "encoder-failure-test".to_string(),
        ])
        .unwrap();

        assert!(matches!(options.scenario, Scenario::EncoderFailure));
    }

    #[test]
    fn parses_source_close_scenario() {
        let options = Options::parse(vec![
            "native_capture_spike".to_string(),
            "--scenario".to_string(),
            "source-close".to_string(),
            "--build-id".to_string(),
            "a73e733".to_string(),
        ])
        .unwrap();

        assert!(matches!(options.scenario, Scenario::SourceClose));
    }

    #[test]
    fn parses_no_capture_encoder_capability_scenario() {
        let options = Options::parse(vec![
            "native_capture_spike".to_string(),
            "--scenario".to_string(),
            "encoder-capability".to_string(),
            "--build-id".to_string(),
            "a73e733".to_string(),
        ])
        .unwrap();

        assert!(matches!(options.scenario, Scenario::EncoderCapability));
        assert_eq!(
            CAPABILITY_PROFILES,
            [
                EncoderProfile::new(3840, 2160, 60),
                EncoderProfile::new(3840, 2160, 30),
                EncoderProfile::new(2560, 1440, 60),
                EncoderProfile::new(1920, 1080, 60),
            ]
        );
        assert_eq!(
            capability_frame_bytes(CAPABILITY_PROFILES[0]).unwrap(),
            33_177_600
        );
    }

    #[test]
    fn validates_bounded_run_ids_and_countdowns() {
        assert_eq!(
            validate_run_id("1440p60-pass_02").unwrap(),
            "1440p60-pass_02"
        );
        assert!(validate_run_id("../outside").is_err());
        assert!(validate_run_id("").is_err());

        let options = Options::parse(vec![
            "native_capture_spike".to_string(),
            "--build-id".to_string(),
            "a73e733".to_string(),
            "--countdown".to_string(),
            "5".to_string(),
        ])
        .unwrap();
        assert_eq!(options.countdown_seconds, 5);

        assert!(Options::parse(vec![
            "native_capture_spike".to_string(),
            "--build-id".to_string(),
            "a73e733".to_string(),
            "--countdown".to_string(),
            "31".to_string(),
        ])
        .is_err());
    }

    #[test]
    fn requires_a_hexadecimal_source_revision() {
        assert_eq!(validate_build_id("A73E733").unwrap(), "a73e733");
        assert!(validate_build_id("not-a-commit").is_err());
        assert!(Options::parse(vec!["native_capture_spike".to_string()]).is_err());
    }

    #[test]
    fn redacts_executable_path_from_report_command() {
        let command = sanitize_command(&[
            "C:\\Users\\name\\project\\native_capture_spike.exe".to_string(),
            "--output-dir".to_string(),
            "C:\\Users\\name\\reports".to_string(),
            "--scenario".to_string(),
            "encoder-failure".to_string(),
        ]);

        assert_eq!(command[0], "native_capture_spike.exe");
        assert_eq!(command[1], "--output-dir");
        assert_eq!(command[2], ".");
        assert_eq!(command[3], "--scenario");
    }

    #[test]
    fn report_artifact_labels_never_include_parent_paths() {
        assert_eq!(
            artifact_label(&std::path::PathBuf::from(
                "C:\\Users\\name\\reports\\capture.mp4"
            )),
            "artifact:capture.mp4"
        );
    }
}
