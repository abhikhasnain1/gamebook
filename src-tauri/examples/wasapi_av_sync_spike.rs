#![cfg(target_os = "windows")]

use std::{
    env,
    error::Error,
    f32::consts::TAU,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    ptr::{addr_of, copy_nonoverlapping, null_mut, read_unaligned},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
        Media::{
            Audio::{
                eMultimedia, eRender, IAudioCaptureClient, IAudioClient, IMMDevice,
                IMMDeviceEnumerator, MMDeviceEnumerator, PlaySoundW,
                AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT,
                AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, SND_ASYNC,
                SND_FILENAME, SND_LOOP, SND_PURGE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
            },
            KernelStreaming::WAVE_FORMAT_EXTENSIBLE,
            MediaFoundation::{
                IMFAttributes, IMFByteStream, IMFMediaBuffer, IMFMediaType, IMFSample,
                IMFSinkWriter, MFAudioFormat_AAC, MFAudioFormat_PCM, MFCreateMediaType,
                MFCreateMemoryBuffer, MFCreateSample, MFCreateSinkWriterFromURL, MFMediaType_Audio,
                MFShutdown, MFStartup, MFSTARTUP_FULL, MF_MT_AAC_PAYLOAD_TYPE,
                MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE,
                MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
                MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_VERSION,
            },
            Multimedia::WAVE_FORMAT_IEEE_FLOAT,
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
                COINIT_MULTITHREADED,
            },
            Performance::{QueryPerformanceCounter, QueryPerformanceFrequency},
            Threading::{CreateEventW, WaitForSingleObject},
        },
    },
};

type SpikeError = Box<dyn Error + Send + Sync>;

const REPORT_SCHEMA: &str = "gamebook.wasapi-av-sync-spike.v1";
const PCM_OUTPUT_BITS: u16 = 16;
const AAC_BYTES_PER_SECOND: u32 = 24_000;
const VIDEO_REFERENCE_FPS: u32 = 60;
const REQUESTED_SHARED_BUFFER_100NS: i64 = 1_000_000;
const WAVE_FORMAT_PCM_TAG: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = WAVE_FORMAT_IEEE_FLOAT as u16;
const WAVE_FORMAT_EXTENSIBLE_TAG: u16 = WAVE_FORMAT_EXTENSIBLE as u16;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Scenario {
    ActiveAudio,
    Silence,
    Cancel,
    AudioFailure,
    EndpointChange,
    EncoderFailure,
}

impl Scenario {
    fn parse(value: &str) -> Result<Self, SpikeError> {
        match value {
            "active-audio" => Ok(Self::ActiveAudio),
            "silence" => Ok(Self::Silence),
            "cancel" => Ok(Self::Cancel),
            "audio-failure" => Ok(Self::AudioFailure),
            "endpoint-change" => Ok(Self::EndpointChange),
            "encoder-failure" => Ok(Self::EncoderFailure),
            _ => Err("--scenario must be active-audio, silence, cancel, audio-failure, endpoint-change, or encoder-failure".into()),
        }
    }

    fn stimulus(self) -> Option<Stimulus> {
        match self {
            Self::ActiveAudio => Some(Stimulus::Tone),
            Self::Silence | Self::AudioFailure | Self::EndpointChange => Some(Stimulus::Silence),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stimulus {
    Tone,
    Silence,
}

#[derive(Clone)]
struct Options {
    scenario: Scenario,
    build_id: String,
    duration: Duration,
    countdown_seconds: u64,
    output_dir: PathBuf,
    run_id: String,
    args: Vec<String>,
}

impl Options {
    fn parse(args: Vec<String>) -> Result<Self, SpikeError> {
        let mut scenario = Scenario::ActiveAudio;
        let mut build_id = None;
        let mut duration_seconds = 30_u64;
        let mut countdown_seconds = 3_u64;
        let mut output_dir = PathBuf::from("src-tauri/target/wasapi-av-sync-spike");
        let mut run_id = format!("wasapi-av-sync-{}", unix_seconds());
        let mut index = 1;

        while index < args.len() {
            match args[index].as_str() {
                "--scenario" => {
                    index += 1;
                    scenario =
                        Scenario::parse(args.get(index).ok_or("--scenario requires a value")?)?;
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

        Ok(Self {
            scenario,
            build_id: build_id.ok_or("--build-id is required")?,
            duration: Duration::from_secs(duration_seconds),
            countdown_seconds,
            output_dir,
            run_id,
            args,
        })
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum SourceSampleFormat {
    Pcm16,
    Pcm24,
    Pcm32,
    Float32,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioFormatReport {
    channels: u16,
    samples_per_second: u32,
    source_bits_per_sample: u16,
    source_block_alignment: u16,
    source_sample_format: SourceSampleFormat,
    encoder_bits_per_sample: u16,
    encoder_average_bytes_per_second: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpikeReport {
    schema: &'static str,
    issue: u32,
    started_at: String,
    completed_at: String,
    command: Vec<String>,
    scenario: Scenario,
    result: String,
    error_message: Option<String>,
    requested_duration_ms: u128,
    default_endpoint_kind: &'static str,
    microphone_capture_enabled: bool,
    capture_endpoint_activated: bool,
    controlled_stimulus: Option<&'static str>,
    audio_format: Option<AudioFormatReport>,
    endpoint_buffer_frames: Option<u32>,
    endpoint_buffer_duration_ms: Option<f64>,
    packets_captured: u64,
    frames_captured: u64,
    silent_frames: u64,
    discontinuity_packets: u64,
    timestamp_error_packets: u64,
    first_device_position: Option<u64>,
    last_device_position: Option<u64>,
    first_audio_qpc_100ns: Option<u64>,
    last_audio_qpc_100ns: Option<u64>,
    audio_timeline_duration_ms: Option<f64>,
    video_reference_frames: u64,
    video_reference_duration_ms: Option<f64>,
    initial_av_offset_ms: Option<f64>,
    final_av_offset_ms: Option<f64>,
    av_drift_ms: Option<f64>,
    output_path: String,
    output_bytes: Option<u64>,
    encoded_duration_ms: Option<f64>,
    encoded_duration_error_ms: Option<f64>,
    finalization_ms: Option<u128>,
    cancelled: bool,
    cleaned_partial_output: bool,
    endpoint_changed: bool,
    environment: EnvironmentReport,
    notes: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentReport {
    application_build: ApplicationBuild,
    exe: String,
    current_dir: &'static str,
    os: &'static str,
    arch: &'static str,
    family: &'static str,
    windows_crate_version: &'static str,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentProbe {
    name: &'static str,
    command: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

struct ComGuard;

impl ComGuard {
    fn initialize() -> Result<Self, SpikeError> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
        Ok(Self)
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct MediaFoundationGuard;

impl MediaFoundationGuard {
    fn initialize() -> Result<Self, SpikeError> {
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL)? };
        Ok(Self)
    }
}

impl Drop for MediaFoundationGuard {
    fn drop(&mut self) {
        let _ = unsafe { MFShutdown() };
    }
}

struct EventHandle(HANDLE);

impl EventHandle {
    fn new() -> Result<Self, SpikeError> {
        let handle = unsafe { CreateEventW(None, false, false, None)? };
        Ok(Self(handle))
    }
}

impl Drop for EventHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

struct MixFormat {
    ptr: *mut WAVEFORMATEX,
    report: AudioFormatReport,
}

impl MixFormat {
    unsafe fn from_audio_client(client: &IAudioClient) -> Result<Self, SpikeError> {
        let ptr = unsafe { client.GetMixFormat()? };
        let base = unsafe { read_unaligned(ptr) };
        let channels = base.nChannels;
        let samples_per_second = base.nSamplesPerSec;
        let source_sample_format = unsafe { classify_source_format(ptr, base)? };
        if !matches!(samples_per_second, 44_100 | 48_000) {
            unsafe { CoTaskMemFree(Some(ptr.cast())) };
            return Err(format!(
                "AAC spike supports 44100 or 48000 Hz mix formats; found {}",
                samples_per_second
            )
            .into());
        }
        if !matches!(channels, 1 | 2) {
            unsafe { CoTaskMemFree(Some(ptr.cast())) };
            return Err(format!(
                "AAC spike supports mono or stereo mix formats; found {} channels",
                channels
            )
            .into());
        }
        Ok(Self {
            ptr,
            report: AudioFormatReport {
                channels,
                samples_per_second,
                source_bits_per_sample: base.wBitsPerSample,
                source_block_alignment: base.nBlockAlign,
                source_sample_format,
                encoder_bits_per_sample: PCM_OUTPUT_BITS,
                encoder_average_bytes_per_second: AAC_BYTES_PER_SECOND,
            },
        })
    }
}

impl Drop for MixFormat {
    fn drop(&mut self) {
        unsafe { CoTaskMemFree(Some(self.ptr.cast())) };
    }
}

struct AacWriter {
    writer: IMFSinkWriter,
    stream_index: u32,
}

struct StimulusGuard {
    path: PathBuf,
    playing: bool,
}

impl StimulusGuard {
    fn new(path: PathBuf, stimulus: Stimulus) -> Result<Self, SpikeError> {
        write_stimulus_wave(&path, stimulus)?;
        Ok(Self {
            path,
            playing: false,
        })
    }

    fn start(&mut self) -> Result<(), SpikeError> {
        start_stimulus(&self.path)?;
        self.playing = true;
        Ok(())
    }

    fn stop(&mut self) {
        if self.playing {
            stop_stimulus();
            self.playing = false;
        }
    }
}

impl Drop for StimulusGuard {
    fn drop(&mut self) {
        self.stop();
        let _ = fs::remove_file(&self.path);
    }
}

impl AacWriter {
    unsafe fn new(path: &Path, format: AudioFormatReport) -> Result<Self, SpikeError> {
        let wide_path = wide(path.as_os_str().to_string_lossy().as_ref());
        let writer = unsafe {
            MFCreateSinkWriterFromURL(
                PCWSTR(wide_path.as_ptr()),
                None::<&IMFByteStream>,
                None::<&IMFAttributes>,
            )?
        };
        let output_type = unsafe { create_aac_output_type(format)? };
        let stream_index = unsafe { writer.AddStream(&output_type)? };
        let input_type = unsafe { create_pcm_input_type(format)? };
        unsafe { writer.SetInputMediaType(stream_index, &input_type, None::<&IMFAttributes>)? };
        unsafe { writer.BeginWriting()? };
        Ok(Self {
            writer,
            stream_index,
        })
    }

    unsafe fn write_pcm16(
        &self,
        bytes: &[u8],
        timestamp_100ns: i64,
        duration_100ns: i64,
    ) -> Result<(), SpikeError> {
        let length = u32::try_from(bytes.len())?;
        let buffer: IMFMediaBuffer = unsafe { MFCreateMemoryBuffer(length)? };
        let mut destination = null_mut();
        unsafe { buffer.Lock(&mut destination, None, None)? };
        unsafe { copy_nonoverlapping(bytes.as_ptr(), destination, bytes.len()) };
        unsafe { buffer.Unlock()? };
        unsafe { buffer.SetCurrentLength(length)? };

        let sample: IMFSample = unsafe { MFCreateSample()? };
        unsafe { sample.AddBuffer(&buffer)? };
        unsafe { sample.SetSampleTime(timestamp_100ns)? };
        unsafe { sample.SetSampleDuration(duration_100ns)? };
        unsafe { self.writer.WriteSample(self.stream_index, &sample)? };
        Ok(())
    }

    unsafe fn finalize(self) -> Result<(), SpikeError> {
        unsafe { self.writer.Finalize()? };
        Ok(())
    }
}

#[derive(Default)]
struct CaptureMetrics {
    packets: u64,
    frames: u64,
    silent_frames: u64,
    discontinuities: u64,
    timestamp_errors: u64,
    first_device_position: Option<u64>,
    last_device_position: Option<u64>,
    first_audio_qpc: Option<u64>,
    last_audio_qpc: Option<u64>,
    last_packet_frames: u32,
}

fn main() -> Result<(), SpikeError> {
    let options = Options::parse(env::args().collect())?;
    fs::create_dir_all(&options.output_dir)?;
    run_countdown(options.countdown_seconds)?;

    let report = run(&options).unwrap_or_else(|error| startup_failure_report(&options, &error));
    let report_path = options.output_dir.join(format!("{}.json", options.run_id));
    fs::write(&report_path, serde_json::to_string_pretty(&report)?)?;
    println!("Report: {}", report_path.display());

    if report.result == "completed" || report.result == "cancelled" {
        Ok(())
    } else {
        Err(report
            .error_message
            .unwrap_or_else(|| report.result.clone())
            .into())
    }
}

fn run(options: &Options) -> Result<SpikeReport, SpikeError> {
    let started_at = unix_time_label();
    let output_path = if matches!(options.scenario, Scenario::EncoderFailure) {
        options.output_dir.clone()
    } else {
        options.output_dir.join(format!("{}.mp4", options.run_id))
    };
    if output_path.is_file() {
        fs::remove_file(&output_path)?;
    }

    let _com = ComGuard::initialize()?;
    let _mf = MediaFoundationGuard::initialize()?;
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
    let endpoint = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)? };
    let initial_endpoint_id = unsafe { endpoint_id(&endpoint)? };
    let audio_client: IAudioClient = unsafe { endpoint.Activate(CLSCTX_ALL, None)? };
    let mix_format = unsafe { MixFormat::from_audio_client(&audio_client)? };
    let format = mix_format.report;

    let event = EventHandle::new()?;
    unsafe {
        audio_client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                REQUESTED_SHARED_BUFFER_100NS,
                0,
                mix_format.ptr,
                None,
            )
            .map_err(|error| windows_stage_error("WASAPI loopback initialization", error))?;
        audio_client
            .SetEventHandle(event.0)
            .map_err(|error| windows_stage_error("WASAPI event registration", error))?;
    }
    let endpoint_buffer_frames = unsafe { audio_client.GetBufferSize()? };
    let endpoint_buffer_duration_ms =
        frames_to_ms(endpoint_buffer_frames, format.samples_per_second);
    let capture_client: IAudioCaptureClient = unsafe { audio_client.GetService()? };
    let writer =
        unsafe { AacWriter::new(&output_path, format) }.map_err(|error| -> SpikeError {
            format!("Media Foundation AAC sink writer initialization failed: {error}").into()
        })?;

    let mut stimulus_guard = if let Some(stimulus) = options.scenario.stimulus() {
        let path = options
            .output_dir
            .join(format!("{}-stimulus.wav", options.run_id));
        Some(StimulusGuard::new(path, stimulus)?)
    } else {
        None
    };

    unsafe { audio_client.Start()? };
    if let Some(stimulus) = stimulus_guard.as_mut() {
        stimulus.start()?;
    }

    let qpc_frequency = qpc_frequency()?;
    let video_start_qpc = qpc_now()?;
    let wall_start = Instant::now();
    let cancel_after = options.duration.min(Duration::from_secs(5));
    let fail_after = options.duration.min(Duration::from_secs(5));
    let mut metrics = CaptureMetrics::default();
    let mut endpoint_changed = false;
    let mut audio_failed = false;
    let mut error_message = None;
    let mut result = "completed".to_string();

    while wall_start.elapsed() < options.duration {
        let elapsed = wall_start.elapsed();
        if matches!(options.scenario, Scenario::Cancel) && elapsed >= cancel_after {
            result = "cancelled".to_string();
            break;
        }
        if matches!(options.scenario, Scenario::AudioFailure)
            && elapsed >= fail_after
            && !audio_failed
        {
            result = "audio-failed".to_string();
            error_message = Some("Simulated post-start audio failure.".to_string());
            let _ = unsafe { audio_client.Stop() };
            audio_failed = true;
        }

        if audio_failed {
            thread::sleep(Duration::from_millis(20));
        } else {
            let wait_result = unsafe { WaitForSingleObject(event.0, 200) };
            if wait_result == WAIT_OBJECT_0 {
                drain_packets(&capture_client, &writer, format, &mut metrics)?;
            }
        }

        if matches!(options.scenario, Scenario::EndpointChange) && !endpoint_changed {
            if let Ok(current) = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) }
            {
                endpoint_changed = unsafe { endpoint_id(&current)? } != initial_endpoint_id;
            }
        }

        print!(
            "\r{} packets, {} frames, {:.1}s",
            metrics.packets,
            metrics.frames,
            elapsed.as_secs_f64()
        );
        std::io::stdout().flush()?;
    }

    let video_end_qpc = qpc_now()?;
    let video_reference_duration_ms = qpc_delta_ms(video_start_qpc, video_end_qpc, qpc_frequency);
    let video_reference_frames =
        ((video_reference_duration_ms / 1000.0) * f64::from(VIDEO_REFERENCE_FPS)).round() as u64;

    let _ = unsafe { audio_client.Stop() };
    if let Some(stimulus) = stimulus_guard.as_mut() {
        stimulus.stop();
    }
    println!();

    let cancelled = result == "cancelled";
    let finalization_started = Instant::now();
    let finalization_result = if cancelled {
        drop(writer);
        Ok(())
    } else {
        unsafe { writer.finalize() }
    };
    let finalization_ms = (!cancelled).then(|| finalization_started.elapsed().as_millis());
    if let Err(error) = finalization_result {
        result = "finalization-failed".to_string();
        error_message = Some(sanitize_error(&error.to_string(), &[&output_path]));
    }

    let cleaned_partial_output = if cancelled || result == "finalization-failed" {
        ensure_output_absent(&output_path)?
    } else {
        false
    };
    if matches!(options.scenario, Scenario::EndpointChange) && !endpoint_changed {
        result = "endpoint-not-changed".to_string();
        error_message = Some("No default render endpoint change was observed.".to_string());
    }

    let audio_timeline_duration_ms = audio_timeline_duration_ms(&metrics, format);
    let initial_av_offset_ms = metrics.first_audio_qpc.map(|value| {
        qpc_100ns_to_ms(value as i128 - qpc_to_100ns(video_start_qpc, qpc_frequency) as i128)
    });
    let audio_end_qpc = metrics.last_audio_qpc.map(|last| {
        last + frames_to_100ns(metrics.last_packet_frames, format.samples_per_second) as u64
    });
    let final_av_offset_ms = audio_end_qpc.map(|value| {
        qpc_100ns_to_ms(value as i128 - qpc_to_100ns(video_end_qpc, qpc_frequency) as i128)
    });
    let av_drift_ms = initial_av_offset_ms
        .zip(final_av_offset_ms)
        .map(|(initial, final_offset)| final_offset - initial);

    let output_bytes = file_bytes(&output_path);
    let encoded_duration_ms = if result == "completed" || result == "audio-failed" {
        probe_output_duration_ms(&output_path)
    } else {
        None
    };
    let encoded_duration_error_ms =
        encoded_duration_ms.map(|duration| duration - options.duration.as_secs_f64() * 1000.0);

    Ok(SpikeReport {
        schema: REPORT_SCHEMA,
        issue: 7,
        started_at,
        completed_at: unix_time_label(),
        command: sanitize_command(&options.args),
        scenario: options.scenario,
        result,
        error_message,
        requested_duration_ms: options.duration.as_millis(),
        default_endpoint_kind: "render",
        microphone_capture_enabled: false,
        capture_endpoint_activated: false,
        controlled_stimulus: options.scenario.stimulus().map(|value| match value {
            Stimulus::Tone => "local-tone",
            Stimulus::Silence => "local-silence",
        }),
        audio_format: Some(format),
        endpoint_buffer_frames: Some(endpoint_buffer_frames),
        endpoint_buffer_duration_ms: Some(endpoint_buffer_duration_ms),
        packets_captured: metrics.packets,
        frames_captured: metrics.frames,
        silent_frames: metrics.silent_frames,
        discontinuity_packets: metrics.discontinuities,
        timestamp_error_packets: metrics.timestamp_errors,
        first_device_position: metrics.first_device_position,
        last_device_position: metrics.last_device_position,
        first_audio_qpc_100ns: metrics.first_audio_qpc,
        last_audio_qpc_100ns: metrics.last_audio_qpc,
        audio_timeline_duration_ms,
        video_reference_frames,
        video_reference_duration_ms: Some(video_reference_duration_ms),
        initial_av_offset_ms,
        final_av_offset_ms,
        av_drift_ms,
        output_path: artifact_label(&output_path),
        output_bytes,
        encoded_duration_ms,
        encoded_duration_error_ms,
        finalization_ms,
        cancelled,
        cleaned_partial_output,
        endpoint_changed,
        environment: EnvironmentReport::current(&options.build_id)?,
        notes: vec![
            "The harness activates only the default render endpoint in WASAPI loopback mode; no microphone or capture endpoint is available through its arguments.".to_string(),
            "Audio packet QPC timestamps and the 60 FPS reference timeline use the same performance-counter clock.".to_string(),
            "Generated audio and reports are local spike artifacts and are never added to a Gamebook project.".to_string(),
        ],
    })
}

fn startup_failure_report(options: &Options, error: &SpikeError) -> SpikeReport {
    let output_path = options.output_dir.join(format!("{}.mp4", options.run_id));
    let cleaned = ensure_output_absent(&output_path).unwrap_or(false);
    SpikeReport {
        schema: REPORT_SCHEMA,
        issue: 7,
        started_at: unix_time_label(),
        completed_at: unix_time_label(),
        command: sanitize_command(&options.args),
        scenario: options.scenario,
        result: "startup-failed".to_string(),
        error_message: Some(sanitize_error(&error.to_string(), &[&output_path, &options.output_dir])),
        requested_duration_ms: options.duration.as_millis(),
        default_endpoint_kind: "render",
        microphone_capture_enabled: false,
        capture_endpoint_activated: false,
        controlled_stimulus: None,
        audio_format: None,
        endpoint_buffer_frames: None,
        endpoint_buffer_duration_ms: None,
        packets_captured: 0,
        frames_captured: 0,
        silent_frames: 0,
        discontinuity_packets: 0,
        timestamp_error_packets: 0,
        first_device_position: None,
        last_device_position: None,
        first_audio_qpc_100ns: None,
        last_audio_qpc_100ns: None,
        audio_timeline_duration_ms: None,
        video_reference_frames: 0,
        video_reference_duration_ms: None,
        initial_av_offset_ms: None,
        final_av_offset_ms: None,
        av_drift_ms: None,
        output_path: artifact_label(&output_path),
        output_bytes: None,
        encoded_duration_ms: None,
        encoded_duration_error_ms: None,
        finalization_ms: None,
        cancelled: false,
        cleaned_partial_output: cleaned,
        endpoint_changed: false,
        environment: EnvironmentReport::current(&options.build_id).unwrap_or_else(|_| {
            EnvironmentReport::minimal(&options.build_id)
        }),
        notes: vec![
            "Startup failure occurred before a project record or microphone-capable endpoint could be created.".to_string(),
        ],
    }
}

fn drain_packets(
    capture: &IAudioCaptureClient,
    writer: &AacWriter,
    format: AudioFormatReport,
    metrics: &mut CaptureMetrics,
) -> Result<(), SpikeError> {
    loop {
        let packet_frames = unsafe { capture.GetNextPacketSize()? };
        if packet_frames == 0 {
            break;
        }

        let mut data = null_mut();
        let mut frames = 0_u32;
        let mut flags = 0_u32;
        let mut device_position = 0_u64;
        let mut qpc_position = 0_u64;
        unsafe {
            capture.GetBuffer(
                &mut data,
                &mut frames,
                &mut flags,
                Some(&mut device_position),
                Some(&mut qpc_position),
            )?;
        }

        let packet_result = (|| -> Result<Vec<u8>, SpikeError> {
            let converted = convert_to_pcm16(data, frames, flags, format)?;
            let first_qpc = *metrics.first_audio_qpc.get_or_insert(qpc_position);
            let timestamp = i64::try_from(qpc_position.saturating_sub(first_qpc))?;
            let duration = frames_to_100ns(frames, format.samples_per_second);
            unsafe { writer.write_pcm16(&converted, timestamp, duration)? };
            Ok(converted)
        })();
        let release_result = unsafe { capture.ReleaseBuffer(frames) };
        let converted = packet_result?;
        release_result?;

        metrics.packets += 1;
        metrics.frames += u64::from(frames);
        if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0
            || converted.iter().all(|byte| *byte == 0)
        {
            metrics.silent_frames += u64::from(frames);
        }
        if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
            metrics.discontinuities += 1;
        }
        if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0 {
            metrics.timestamp_errors += 1;
        }
        metrics.first_device_position.get_or_insert(device_position);
        metrics.last_device_position = Some(device_position);
        metrics.last_audio_qpc = Some(qpc_position);
        metrics.last_packet_frames = frames;
    }
    Ok(())
}

fn convert_to_pcm16(
    data: *mut u8,
    frames: u32,
    flags: u32,
    format: AudioFormatReport,
) -> Result<Vec<u8>, SpikeError> {
    let samples = usize::try_from(frames)? * usize::from(format.channels);
    if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
        return Ok(vec![0; samples * 2]);
    }
    let source_len = usize::try_from(frames)? * usize::from(format.source_block_alignment);
    let source = unsafe { std::slice::from_raw_parts(data, source_len) };
    let mut output = Vec::with_capacity(samples * 2);

    match format.source_sample_format {
        SourceSampleFormat::Pcm16 => output.extend_from_slice(source),
        SourceSampleFormat::Float32 => {
            for chunk in source.chunks_exact(4) {
                let sample = f32::from_le_bytes(chunk.try_into()?).clamp(-1.0, 1.0);
                let value = (sample * f32::from(i16::MAX)).round() as i16;
                output.extend_from_slice(&value.to_le_bytes());
            }
        }
        SourceSampleFormat::Pcm24 => {
            for chunk in source.chunks_exact(3) {
                let raw = i32::from_le_bytes([
                    chunk[0],
                    chunk[1],
                    chunk[2],
                    if chunk[2] & 0x80 != 0 { 0xff } else { 0x00 },
                ]);
                output.extend_from_slice(&((raw >> 8) as i16).to_le_bytes());
            }
        }
        SourceSampleFormat::Pcm32 => {
            for chunk in source.chunks_exact(4) {
                let raw = i32::from_le_bytes(chunk.try_into()?);
                output.extend_from_slice(&((raw >> 16) as i16).to_le_bytes());
            }
        }
    }

    if output.len() != samples * 2 {
        return Err("Captured packet size does not match the declared mix format.".into());
    }
    Ok(output)
}

unsafe fn classify_source_format(
    ptr: *mut WAVEFORMATEX,
    base: WAVEFORMATEX,
) -> Result<SourceSampleFormat, SpikeError> {
    let tag = base.wFormatTag;
    let bits = base.wBitsPerSample;
    match (tag, bits) {
        (WAVE_FORMAT_PCM_TAG, 16) => Ok(SourceSampleFormat::Pcm16),
        (WAVE_FORMAT_PCM_TAG, 24) => Ok(SourceSampleFormat::Pcm24),
        (WAVE_FORMAT_PCM_TAG, 32) => Ok(SourceSampleFormat::Pcm32),
        (WAVE_FORMAT_IEEE_FLOAT_TAG, 32) => Ok(SourceSampleFormat::Float32),
        (WAVE_FORMAT_EXTENSIBLE_TAG, _) if usize::from(base.cbSize) >= 22 => {
            let extensible = ptr.cast::<WAVEFORMATEXTENSIBLE>();
            let subtype = unsafe { read_unaligned(addr_of!((*extensible).SubFormat)) };
            if subtype == windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
                && bits == 32
            {
                Ok(SourceSampleFormat::Float32)
            } else if subtype == windows::Win32::Media::KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM {
                match bits {
                    16 => Ok(SourceSampleFormat::Pcm16),
                    24 => Ok(SourceSampleFormat::Pcm24),
                    32 => Ok(SourceSampleFormat::Pcm32),
                    _ => Err(format!("Unsupported extensible PCM bit depth: {bits}").into()),
                }
            } else {
                Err("Unsupported extensible WASAPI mix subtype.".into())
            }
        }
        _ => Err(format!("Unsupported WASAPI mix format tag {tag} with {bits} bits").into()),
    }
}

unsafe fn create_aac_output_type(format: AudioFormatReport) -> Result<IMFMediaType, SpikeError> {
    let media_type = unsafe { MFCreateMediaType()? };
    unsafe {
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
        media_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, u32::from(PCM_OUTPUT_BITS))?;
        media_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, format.samples_per_second)?;
        media_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, u32::from(format.channels))?;
        media_type.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AAC_BYTES_PER_SECOND)?;
        media_type.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)?;
    }
    Ok(media_type)
}

unsafe fn create_pcm_input_type(format: AudioFormatReport) -> Result<IMFMediaType, SpikeError> {
    let media_type = unsafe { MFCreateMediaType()? };
    let block_alignment = u32::from(format.channels) * 2;
    unsafe {
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
        media_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, u32::from(PCM_OUTPUT_BITS))?;
        media_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, format.samples_per_second)?;
        media_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, u32::from(format.channels))?;
        media_type.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, block_alignment)?;
        media_type.SetUINT32(
            &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
            format.samples_per_second * block_alignment,
        )?;
    }
    Ok(media_type)
}

unsafe fn endpoint_id(device: &IMMDevice) -> Result<String, SpikeError> {
    let id: PWSTR = unsafe { device.GetId()? };
    let value = unsafe { id.to_string()? };
    unsafe { CoTaskMemFree(Some(id.0.cast())) };
    Ok(value)
}

fn write_stimulus_wave(path: &Path, stimulus: Stimulus) -> Result<(), SpikeError> {
    const SAMPLE_RATE: u32 = 48_000;
    const CHANNELS: u16 = 2;
    const BITS: u16 = 16;
    let frames = SAMPLE_RATE;
    let mut pcm = Vec::with_capacity(frames as usize * usize::from(CHANNELS) * 2);
    for frame in 0..frames {
        let value = if matches!(stimulus, Stimulus::Tone) {
            let phase = frame as f32 * 440.0 * TAU / SAMPLE_RATE as f32;
            (phase.sin() * 0.08 * f32::from(i16::MAX)) as i16
        } else {
            0
        };
        for _ in 0..CHANNELS {
            pcm.extend_from_slice(&value.to_le_bytes());
        }
    }

    let data_len = u32::try_from(pcm.len())?;
    let byte_rate = SAMPLE_RATE * u32::from(CHANNELS) * u32::from(BITS / 8);
    let block_align = CHANNELS * (BITS / 8);
    let mut wave = Vec::with_capacity(pcm.len() + 44);
    wave.extend_from_slice(b"RIFF");
    wave.extend_from_slice(&(36 + data_len).to_le_bytes());
    wave.extend_from_slice(b"WAVEfmt ");
    wave.extend_from_slice(&16_u32.to_le_bytes());
    wave.extend_from_slice(&1_u16.to_le_bytes());
    wave.extend_from_slice(&CHANNELS.to_le_bytes());
    wave.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wave.extend_from_slice(&byte_rate.to_le_bytes());
    wave.extend_from_slice(&block_align.to_le_bytes());
    wave.extend_from_slice(&BITS.to_le_bytes());
    wave.extend_from_slice(b"data");
    wave.extend_from_slice(&data_len.to_le_bytes());
    wave.extend_from_slice(&pcm);
    fs::write(path, wave)?;
    Ok(())
}

fn start_stimulus(path: &Path) -> Result<(), SpikeError> {
    let wide_path = wide(path.as_os_str().to_string_lossy().as_ref());
    let started = unsafe {
        PlaySoundW(
            PCWSTR(wide_path.as_ptr()),
            None,
            SND_FILENAME | SND_ASYNC | SND_LOOP,
        )
    };
    if started.as_bool() {
        Ok(())
    } else {
        Err("Controlled audio stimulus could not be started.".into())
    }
}

fn stop_stimulus() {
    unsafe {
        let _ = PlaySoundW(PCWSTR::null(), None, SND_PURGE);
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
                .unwrap_or("wasapi_av_sync_spike.exe")
                .to_string(),
            current_dir: ".",
            os: env::consts::OS,
            arch: env::consts::ARCH,
            family: env::consts::FAMILY,
            windows_crate_version: "0.61.3",
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
                    "audio-devices",
                    "$devices = @(Get-CimInstance Win32_SoundDevice); $statuses = @($devices | Group-Object Status | ForEach-Object { [pscustomobject]@{ Status = $_.Name; Count = $_.Count } }); [pscustomobject]@{ Count = $devices.Count; Statuses = $statuses } | ConvertTo-Json -Compress -Depth 4",
                ),
                powershell_probe(
                    "storage-volumes",
                    "Get-Volume | Select-Object FileSystemType,Size,SizeRemaining,HealthStatus | ConvertTo-Json -Compress",
                ),
                command_probe("power-scheme", "powercfg.exe", &["/GETACTIVESCHEME"]),
            ],
        })
    }

    fn minimal(build_id: &str) -> Self {
        Self {
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
            exe: "wasapi_av_sync_spike.exe".to_string(),
            current_dir: ".",
            os: env::consts::OS,
            arch: env::consts::ARCH,
            family: env::consts::FAMILY,
            windows_crate_version: "0.61.3",
            probes: Vec::new(),
        }
    }
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
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
        .map(|ticks| ticks / 10_000.0)
}

fn qpc_frequency() -> Result<i64, SpikeError> {
    let mut frequency = 0_i64;
    unsafe { QueryPerformanceFrequency(&mut frequency)? };
    Ok(frequency)
}

fn qpc_now() -> Result<i64, SpikeError> {
    let mut value = 0_i64;
    unsafe { QueryPerformanceCounter(&mut value)? };
    Ok(value)
}

fn qpc_to_100ns(value: i64, frequency: i64) -> i64 {
    ((i128::from(value) * 10_000_000_i128) / i128::from(frequency)) as i64
}

fn qpc_delta_ms(start: i64, end: i64, frequency: i64) -> f64 {
    (end - start) as f64 * 1000.0 / frequency as f64
}

fn qpc_100ns_to_ms(value: i128) -> f64 {
    value as f64 / 10_000.0
}

fn frames_to_100ns(frames: u32, sample_rate: u32) -> i64 {
    ((u64::from(frames) * 10_000_000) / u64::from(sample_rate)) as i64
}

fn frames_to_ms(frames: u32, sample_rate: u32) -> f64 {
    f64::from(frames) * 1000.0 / f64::from(sample_rate)
}

fn audio_timeline_duration_ms(metrics: &CaptureMetrics, format: AudioFormatReport) -> Option<f64> {
    metrics
        .first_audio_qpc
        .zip(metrics.last_audio_qpc)
        .map(|(first, last)| {
            (last - first) as f64 / 10_000.0
                + frames_to_ms(metrics.last_packet_frames, format.samples_per_second)
        })
}

fn sanitize_command(args: &[String]) -> Vec<String> {
    let mut sanitized = args.to_vec();
    if let Some(program) = sanitized.first_mut() {
        *program = PathBuf::from(&program)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("wasapi_av_sync_spike.exe")
            .to_string();
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

fn sanitize_error(value: &str, paths: &[&Path]) -> String {
    let mut sanitized = value.to_string();
    for path in paths {
        let candidate = path.display().to_string();
        sanitized = sanitized.replace(&candidate, "<local-path>");
        sanitized = sanitized.replace(&candidate.replace('\\', "/"), "<local-path>");
    }
    sanitized
}

fn windows_stage_error(stage: &str, error: windows::core::Error) -> SpikeError {
    format!("{stage} failed: {error}").into()
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

fn artifact_label(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| format!("artifact:{value}"))
        .unwrap_or_else(|| "artifact".to_string())
}

fn file_bytes(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
}

fn ensure_output_absent(path: &Path) -> Result<bool, SpikeError> {
    if path.is_file() {
        fs::remove_file(path)?;
    }
    Ok(!path.exists() || path.is_dir())
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn run_countdown(seconds: u64) -> Result<(), SpikeError> {
    for remaining in (1..=seconds).rev() {
        print!("\rAudio capture starts in {remaining}s ");
        std::io::stdout().flush()?;
        thread::sleep(Duration::from_secs(1));
    }
    if seconds > 0 {
        println!("\rAudio capture starting now.       ");
    }
    Ok(())
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

fn print_help() {
    println!(
        "WASAPI A/V synchronization spike\n\n\
         cargo run --manifest-path src-tauri/Cargo.toml --example wasapi_av_sync_spike --release -- \\\n+           --build-id COMMIT_SHA --scenario active-audio --duration 30 --countdown 3\n\n\
         Scenarios: active-audio, silence, cancel, audio-failure, endpoint-change, encoder-failure\n\
         The harness captures only the default render endpoint through WASAPI loopback.\n\
         Microphone and capture-endpoint activation are not available."
    );
}

#[cfg(test)]
mod tests {
    use super::{
        frames_to_100ns, qpc_100ns_to_ms, validate_build_id, validate_run_id, Options, Scenario,
    };

    #[test]
    fn validates_bounded_identifiers() {
        assert_eq!(validate_build_id("09E56DE").unwrap(), "09e56de");
        assert!(validate_build_id("not-a-build").is_err());
        assert_eq!(
            validate_run_id("active-audio_01").unwrap(),
            "active-audio_01"
        );
        assert!(validate_run_id("../outside").is_err());
    }

    #[test]
    fn microphone_cannot_be_enabled_by_arguments() {
        let result = Options::parse(vec![
            "wasapi_av_sync_spike.exe".to_string(),
            "--build-id".to_string(),
            "09e56de".to_string(),
            "--microphone".to_string(),
            "true".to_string(),
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn parses_all_scenarios() {
        for value in [
            "active-audio",
            "silence",
            "cancel",
            "audio-failure",
            "endpoint-change",
            "encoder-failure",
        ] {
            assert!(Scenario::parse(value).is_ok());
        }
    }

    #[test]
    fn converts_audio_clock_units_without_floating_point_state() {
        assert_eq!(frames_to_100ns(480, 48_000), 100_000);
        assert_eq!(qpc_100ns_to_ms(500_000), 50.0);
    }
}
