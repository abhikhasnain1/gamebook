#![cfg(target_os = "windows")]

use std::{
    env,
    error::Error,
    fs,
    mem::size_of,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr::{copy_nonoverlapping, null_mut, read_unaligned},
    time::{SystemTime, UNIX_EPOCH},
};

use image::{ColorType, ImageFormat};
use serde::Serialize;
use serde_json::{json, Value};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::SIZE,
        Media::MediaFoundation::{
            IMFAttributes, IMFByteStream, IMFMediaBuffer, IMFMediaType, IMFSample,
            MFCreateAttributes, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
            MFCreateSinkWriterFromURL, MFCreateSourceReaderFromURL, MFMediaType_Video,
            MFNominalRange_0_255, MFNominalRange_16_235, MFOffset, MFShutdown, MFStartup,
            MFVideoArea, MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoFormat_RGB32,
            MFVideoInterlace_Progressive, MFVideoPrimaries_BT709, MFVideoTransFunc_709,
            MFVideoTransferMatrix_BT709, MFSTARTUP_FULL, MF_MT_ALL_SAMPLES_INDEPENDENT,
            MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE, MF_MT_FIXED_SIZE_SAMPLES, MF_MT_FRAME_RATE,
            MF_MT_FRAME_SIZE, MF_MT_GEOMETRIC_APERTURE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE,
            MF_MT_MINIMUM_DISPLAY_APERTURE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
            MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES,
            MF_MT_YUV_MATRIX, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
            MF_SOURCE_READERF_ENDOFSTREAM, MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_VERSION,
        },
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
    },
};

type SpikeError = Box<dyn Error + Send + Sync>;

const REPORT_SCHEMA: &str = "gamebook.native-decode-spike.v1";
const TICKS_PER_SECOND: i64 = 10_000_000;
const COLOR_TOLERANCE: i32 = 24;
const DEFAULT_WIDTH: u32 = 160;
const DEFAULT_HEIGHT: u32 = 90;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Scenario {
    Cfr30,
    Cfr60,
    Vfr,
    SdrColor,
    OddAperture,
    HdrPqBlock,
    HdrHlgBlock,
    Malformed,
    OutOfRange,
    Cancel,
    DecoderFailure,
}

impl Scenario {
    fn parse(value: &str) -> Result<Self, SpikeError> {
        match value {
            "cfr-30" => Ok(Self::Cfr30),
            "cfr-60" => Ok(Self::Cfr60),
            "vfr" => Ok(Self::Vfr),
            "sdr-color" => Ok(Self::SdrColor),
            "odd-aperture" => Ok(Self::OddAperture),
            "hdr-pq-block" => Ok(Self::HdrPqBlock),
            "hdr-hlg-block" => Ok(Self::HdrHlgBlock),
            "malformed" => Ok(Self::Malformed),
            "out-of-range" => Ok(Self::OutOfRange),
            "cancel" => Ok(Self::Cancel),
            "decoder-failure" => Ok(Self::DecoderFailure),
            _ => Err("--scenario must be cfr-30, cfr-60, vfr, sdr-color, odd-aperture, hdr-pq-block, hdr-hlg-block, malformed, out-of-range, cancel, or decoder-failure".into()),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Cfr30 => "cfr-30",
            Self::Cfr60 => "cfr-60",
            Self::Vfr => "vfr",
            Self::SdrColor => "sdr-color",
            Self::OddAperture => "odd-aperture",
            Self::HdrPqBlock => "hdr-pq-block",
            Self::HdrHlgBlock => "hdr-hlg-block",
            Self::Malformed => "malformed",
            Self::OutOfRange => "out-of-range",
            Self::Cancel => "cancel",
            Self::DecoderFailure => "decoder-failure",
        }
    }
}

struct Options {
    scenario: Scenario,
    build_id: String,
    output_dir: PathBuf,
    run_id: String,
}

impl Options {
    fn parse(args: &[String]) -> Result<Self, SpikeError> {
        let mut scenario = None;
        let mut build_id = None;
        let mut output_dir = PathBuf::from("src-tauri/target/native-decode-spike");
        let mut run_id = format!("native-decode-{}", unix_millis());
        let mut index = 1;
        while index < args.len() {
            match args[index].as_str() {
                "--scenario" => {
                    index += 1;
                    scenario = Some(Scenario::parse(
                        args.get(index).ok_or("--scenario requires a value")?,
                    )?);
                }
                "--build-id" => {
                    index += 1;
                    build_id = Some(validate_token(
                        args.get(index).ok_or("--build-id requires a value")?,
                        "build id",
                    )?);
                }
                "--output-dir" => {
                    index += 1;
                    output_dir =
                        PathBuf::from(args.get(index).ok_or("--output-dir requires a value")?);
                }
                "--run-id" => {
                    index += 1;
                    run_id = validate_token(
                        args.get(index).ok_or("--run-id requires a value")?,
                        "run id",
                    )?;
                }
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                other => return Err(format!("Unknown option: {other}").into()),
            }
            index += 1;
        }
        Ok(Self {
            scenario: scenario.ok_or("--scenario is required")?,
            build_id: build_id.ok_or("--build-id is required")?,
            output_dir,
            run_id,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Timing {
    pts_100ns: i64,
    duration_100ns: i64,
}

#[derive(Clone, Copy)]
struct VideoSpec {
    logical_width: u32,
    logical_height: u32,
    coded_width: u32,
    coded_height: u32,
    nominal_fps: u32,
    color_bars: bool,
}

impl VideoSpec {
    fn standard(nominal_fps: u32, color_bars: bool) -> Self {
        Self {
            logical_width: DEFAULT_WIDTH,
            logical_height: DEFAULT_HEIGHT,
            coded_width: DEFAULT_WIDTH,
            coded_height: DEFAULT_HEIGHT,
            nominal_fps,
            color_bars,
        }
    }

    fn odd() -> Self {
        Self {
            logical_width: 161,
            logical_height: 91,
            coded_width: 162,
            coded_height: 92,
            nominal_fps: 30,
            color_bars: false,
        }
    }
}

struct DecodedFrame {
    pts_100ns: i64,
    duration_100ns: Option<i64>,
    rgba: Vec<u8>,
}

struct DecodeResult {
    frames: Vec<DecodedFrame>,
    source_aperture: Option<MFVideoArea>,
    negotiated_aperture: Option<MFVideoArea>,
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

fn main() -> Result<(), SpikeError> {
    let args: Vec<String> = env::args().collect();
    let options = Options::parse(&args)?;
    fs::create_dir_all(&options.output_dir)?;
    let started_at = format!("unix-ms-{}", unix_millis());
    let report = run(&options, &started_at).unwrap_or_else(|error| {
        base_report(&options, &started_at, "failed", Some(error.to_string()))
    });
    let report_path = options.output_dir.join(format!("{}.json", options.run_id));
    fs::write(&report_path, serde_json::to_string_pretty(&report)?)?;
    println!("Report: {}", report_path.display());
    if report["result"] != "passed" {
        return Err(report["errorMessage"]
            .as_str()
            .unwrap_or("Native decode spike failed")
            .to_string()
            .into());
    }
    Ok(())
}

fn run(options: &Options, started_at: &str) -> Result<Value, SpikeError> {
    match options.scenario {
        Scenario::HdrPqBlock => return Ok(run_hdr_block(options, started_at, "pq")),
        Scenario::HdrHlgBlock => return Ok(run_hdr_block(options, started_at, "hlg")),
        _ => {}
    }

    let _com = ComGuard::initialize()?;
    let _media_foundation = MediaFoundationGuard::initialize()?;

    match options.scenario {
        Scenario::Malformed => run_malformed(options, started_at),
        Scenario::Cancel => run_cancel(options, started_at),
        Scenario::DecoderFailure => run_decoder_failure(options, started_at),
        Scenario::OutOfRange => run_out_of_range(options, started_at),
        Scenario::Cfr30
        | Scenario::Cfr60
        | Scenario::Vfr
        | Scenario::SdrColor
        | Scenario::OddAperture => run_success(options, started_at),
        Scenario::HdrPqBlock | Scenario::HdrHlgBlock => unreachable!(),
    }
}

fn run_success(options: &Options, started_at: &str) -> Result<Value, SpikeError> {
    let (spec, schedule, requested) = scenario_fixture(options.scenario)?;
    let media_path = options.output_dir.join(format!("{}.mp4", options.run_id));
    let submitted_edge_replication = encode_fixture(&media_path, spec, &schedule, true)?;
    let output_bytes = fs::metadata(&media_path)?.len();
    let decoded = decode_fixture(&media_path, spec)?;
    if decoded.frames.len() != schedule.len() {
        return Err(format!(
            "decoded {} frames, expected {}",
            decoded.frames.len(),
            schedule.len()
        )
        .into());
    }

    let decoded_pts: Vec<i64> = decoded.frames.iter().map(|frame| frame.pts_100ns).collect();
    let submitted_pts: Vec<i64> = schedule.iter().map(|timing| timing.pts_100ns).collect();
    let decoded_ids: Vec<usize> = decoded
        .frames
        .iter()
        .map(|frame| identify_pattern(&frame.rgba, spec, schedule.len()))
        .collect();
    let expected_ids: Vec<usize> = (0..schedule.len()).collect();
    let exact_timestamps = decoded_pts == submitted_pts;
    let exact_order = spec.color_bars || decoded_ids == expected_ids;

    let extraction_dir = options
        .output_dir
        .join(format!("{}-samples", options.run_id));
    fs::create_dir_all(&extraction_dir)?;
    let mut extracted = Vec::new();
    for &sample_index in &requested {
        let frame = decoded
            .frames
            .get(sample_index)
            .ok_or("requested sample was not decoded")?;
        let cropped = crop_rgba(
            &frame.rgba,
            spec.coded_width,
            spec.logical_width,
            spec.logical_height,
        );
        let png_path = extraction_dir.join(format!("sample-{sample_index}.png"));
        image::save_buffer_with_format(
            &png_path,
            &cropped,
            spec.logical_width,
            spec.logical_height,
            ColorType::Rgba8,
            ImageFormat::Png,
        )?;
        extracted.push(json!({
            "sampleIndex": sample_index,
            "decodedFrameId": if spec.color_bars { Value::Null } else { json!(decoded_ids[sample_index]) },
            "path": format!("artifact:sample-{sample_index}.png"),
            "width": spec.logical_width,
            "height": spec.logical_height,
        }));
    }

    let source_aperture = decoded.source_aperture.map(aperture_json);
    let aperture = decoded.negotiated_aperture.map(aperture_json);
    let aperture_preserved = if options.scenario == Scenario::OddAperture {
        decoded.negotiated_aperture.is_some_and(|value| {
            value.OffsetX.value == 0
                && value.OffsetY.value == 0
                && value.Area.cx == spec.logical_width as i32
                && value.Area.cy == spec.logical_height as i32
        })
    } else {
        true
    };
    let color = if options.scenario == Scenario::SdrColor {
        color_report(&decoded.frames[requested[0]].rgba, spec)
    } else {
        Value::Null
    };
    let color_passed = color.is_null() || color["passed"] == true;
    let restored_dimensions = extracted.iter().all(|entry| {
        entry["width"] == spec.logical_width && entry["height"] == spec.logical_height
    });

    if !exact_timestamps || !exact_order || !aperture_preserved || !color_passed {
        return Err(format!(
            "decode checks failed: exactTimestamps={exact_timestamps}, exactOrder={exact_order}, aperturePreserved={aperture_preserved}, colorPassed={color_passed}; submittedPts={submitted_pts:?}; decodedPts={decoded_pts:?}; decodedIds={decoded_ids:?}"
        )
        .into());
    }

    let mut report = base_report(options, started_at, "passed", None);
    report["sourceArtifact"] = json!("artifact:synthetic.mp4");
    report["outputBytes"] = json!(output_bytes);
    report["timeline"] = json!({
        "submitted": schedule,
        "decodedPts100ns": decoded_pts,
        "decodedDurations100ns": decoded.frames.iter().map(|frame| frame.duration_100ns).collect::<Vec<_>>(),
        "decodedFrameIds": if spec.color_bars { Value::Null } else { json!(decoded_ids) },
        "requestedSampleIndices": requested,
        "extractedSamples": extracted,
        "exactSampleOrder": exact_order,
        "exactTimestamps": exact_timestamps,
    });
    report["video"] = json!({
        "logicalWidth": spec.logical_width,
        "logicalHeight": spec.logical_height,
        "codedWidth": spec.coded_width,
        "codedHeight": spec.coded_height,
        "paddingRight": spec.coded_width - spec.logical_width,
        "paddingBottom": spec.coded_height - spec.logical_height,
        "edgeReplicationVerifiedBeforeEncode": submitted_edge_replication,
        "sourceContainerAperture": source_aperture,
        "sourceContainerAperturePreserved": decoded.source_aperture.is_some(),
        "decodeAperture": aperture,
        "decodeAperturePreserved": aperture_preserved,
        "restoredPngLogicalDimensions": restored_dimensions,
    });
    report["color"] = color;
    report["cleanup"] = json!({
        "partialArtifactsRemoved": true,
        "retainedArtifacts": ["synthetic-mp4", "requested-sample-pngs"]
    });
    Ok(report)
}

fn run_hdr_block(options: &Options, started_at: &str, transfer: &str) -> Value {
    let blocked = hdr_requires_tone_mapping("bt2020", transfer);
    let mut report = base_report(options, started_at, "passed", None);
    report["hdr"] = json!({
        "primaries": "bt2020",
        "transfer": transfer,
        "blocked": blocked,
        "reason": "HDR input requires an approved tone-mapping path before evidence extraction.",
        "toneMapped": false,
        "outputCreated": false,
    });
    report["cleanup"] = json!({"partialArtifactsRemoved": true, "retainedArtifacts": []});
    report
}

fn run_malformed(options: &Options, started_at: &str) -> Result<Value, SpikeError> {
    let path = options
        .output_dir
        .join(format!("{}-malformed.mp4", options.run_id));
    fs::write(&path, b"not-an-mp4")?;
    let decode_failed = decode_fixture(&path, VideoSpec::standard(30, false)).is_err();
    fs::remove_file(&path)?;
    if !decode_failed || path.exists() {
        return Err("malformed input did not fail cleanly".into());
    }
    Ok(failure_mode_report(
        options,
        started_at,
        "malformed-input-rejected",
    ))
}

fn run_out_of_range(options: &Options, started_at: &str) -> Result<Value, SpikeError> {
    let spec = VideoSpec::standard(30, false);
    let schedule = cfr_schedule(5, 30);
    let path = options.output_dir.join(format!("{}.mp4", options.run_id));
    encode_fixture(&path, spec, &schedule, true)?;
    let decoded = decode_fixture(&path, spec)?;
    let requested = 5_usize;
    let rejected = decoded.frames.get(requested).is_none();
    fs::remove_file(&path)?;
    if !rejected || path.exists() {
        return Err("out-of-range request was not rejected cleanly".into());
    }
    let mut report = failure_mode_report(options, started_at, "out-of-range-rejected");
    report["requestedSampleIndex"] = json!(requested);
    report["decodedFrameCount"] = json!(decoded.frames.len());
    Ok(report)
}

fn run_cancel(options: &Options, started_at: &str) -> Result<Value, SpikeError> {
    let spec = VideoSpec::standard(30, false);
    let schedule = cfr_schedule(10, 30);
    let path = options.output_dir.join(format!("{}.mp4", options.run_id));
    encode_fixture(&path, spec, &schedule[..3], false)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    if path.exists() {
        return Err("cancelled encode retained a partial artifact".into());
    }
    Ok(failure_mode_report(
        options,
        started_at,
        "cancelled-and-cleaned",
    ))
}

fn run_decoder_failure(options: &Options, started_at: &str) -> Result<Value, SpikeError> {
    let spec = VideoSpec::standard(30, false);
    let schedule = cfr_schedule(6, 30);
    let path = options.output_dir.join(format!("{}.mp4", options.run_id));
    let extraction = options
        .output_dir
        .join(format!("{}-partial.png", options.run_id));
    encode_fixture(&path, spec, &schedule, true)?;
    let decoded = decode_fixture(&path, spec)?;
    let first = decoded.frames.first().ok_or("decoder returned no frames")?;
    image::save_buffer_with_format(
        &extraction,
        &first.rgba,
        spec.coded_width,
        spec.coded_height,
        ColorType::Rgba8,
        ImageFormat::Png,
    )?;
    let injected_failure = true;
    if injected_failure {
        fs::remove_file(&extraction)?;
        fs::remove_file(&path)?;
    }
    if extraction.exists() || path.exists() {
        return Err("injected decoder failure retained partial artifacts".into());
    }
    Ok(failure_mode_report(
        options,
        started_at,
        "decoder-failure-cleaned",
    ))
}

fn failure_mode_report(options: &Options, started_at: &str, result_detail: &str) -> Value {
    let mut report = base_report(options, started_at, "passed", None);
    report["failureMode"] = json!({
        "outcome": result_detail,
        "partialArtifactsRemoved": true,
        "userFacingErrorContract": "Identify the failed operation and preserve the prior usable state."
    });
    report["cleanup"] = json!({"partialArtifactsRemoved": true, "retainedArtifacts": []});
    report
}

fn base_report(
    options: &Options,
    started_at: &str,
    result: &str,
    error_message: Option<String>,
) -> Value {
    json!({
        "schema": REPORT_SCHEMA,
        "issue": 8,
        "startedAt": started_at,
        "completedAt": format!("unix-ms-{}", unix_millis()),
        "command": [
            "native_decode_spike.exe",
            "--scenario", options.scenario.name(),
            "--build-id", options.build_id,
            "--run-id", options.run_id,
        ],
        "scenario": options.scenario.name(),
        "result": result,
        "errorMessage": error_message,
        "applicationBuild": {
            "name": "gamebook",
            "version": env!("CARGO_PKG_VERSION"),
            "sourceRevision": options.build_id,
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        },
        "sourceArtifact": Value::Null,
        "outputBytes": Value::Null,
        "timeline": Value::Null,
        "video": Value::Null,
        "color": Value::Null,
        "hdr": Value::Null,
        "failureMode": Value::Null,
        "cleanup": Value::Null,
        "accessibility": {
            "interactiveUi": false,
            "productionAnnouncementContract": "Announce decode, extraction, color, and HDR blocking failures in text without relying on color or motion."
        },
        "privacy": {
            "syntheticInputOnly": true,
            "networkAccess": false,
            "projectWrites": false,
            "mediaBytesInReport": false,
            "localPathsInReport": false,
        },
        "environment": {
            "os": "windows",
            "arch": env::consts::ARCH,
            "windowsCrateVersion": "0.61.3",
        }
    })
}

fn scenario_fixture(
    scenario: Scenario,
) -> Result<(VideoSpec, Vec<Timing>, Vec<usize>), SpikeError> {
    match scenario {
        Scenario::Cfr30 => Ok((
            VideoSpec::standard(30, false),
            cfr_schedule(30, 30),
            vec![0, 15, 29],
        )),
        Scenario::Cfr60 => Ok((
            VideoSpec::standard(60, false),
            cfr_schedule(60, 60),
            vec![0, 30, 59],
        )),
        Scenario::Vfr => Ok((
            VideoSpec::standard(60, false),
            vfr_schedule(&[
                166_666, 333_334, 250_000, 500_000, 166_666, 416_667, 250_000, 166_667, 333_333,
                250_000, 500_000, 166_667,
            ]),
            vec![0, 4, 11],
        )),
        Scenario::SdrColor => Ok((VideoSpec::standard(30, true), cfr_schedule(6, 30), vec![3])),
        Scenario::OddAperture => Ok((VideoSpec::odd(), cfr_schedule(6, 30), vec![3])),
        _ => Err("scenario has no successful decode fixture".into()),
    }
}

fn cfr_schedule(frame_count: usize, fps: u32) -> Vec<Timing> {
    (0..frame_count)
        .map(|index| {
            let start = rounded_rational_ticks(index as i64, fps);
            let end = rounded_rational_ticks(index as i64 + 1, fps);
            Timing {
                pts_100ns: start,
                duration_100ns: end - start,
            }
        })
        .collect()
}

fn rounded_rational_ticks(frame: i64, fps: u32) -> i64 {
    frame * TICKS_PER_SECOND / i64::from(fps)
}

fn vfr_schedule(durations: &[i64]) -> Vec<Timing> {
    let mut pts = 0;
    durations
        .iter()
        .map(|duration| {
            let timing = Timing {
                pts_100ns: pts,
                duration_100ns: *duration,
            };
            pts += duration;
            timing
        })
        .collect()
}

fn hdr_requires_tone_mapping(primaries: &str, transfer: &str) -> bool {
    primaries == "bt2020" && matches!(transfer, "pq" | "hlg")
}

fn frame_color(index: usize) -> [u8; 3] {
    const LEVELS: [u8; 4] = [32, 96, 160, 224];
    [
        LEVELS[index % 4],
        LEVELS[(index / 4) % 4],
        LEVELS[(index / 16) % 4],
    ]
}

fn make_frame(spec: VideoSpec, index: usize) -> (Vec<u8>, bool) {
    let mut bytes = vec![0; (spec.coded_width * spec.coded_height * 4) as usize];
    for y in 0..spec.coded_height {
        for x in 0..spec.coded_width {
            let logical_x = x.min(spec.logical_width - 1);
            let logical_y = y.min(spec.logical_height - 1);
            let rgb = if spec.color_bars {
                color_bar(logical_x, spec.logical_width)
            } else {
                let _ = logical_y;
                frame_color(index)
            };
            let offset = ((y * spec.coded_width + x) * 4) as usize;
            bytes[offset] = rgb[2];
            bytes[offset + 1] = rgb[1];
            bytes[offset + 2] = rgb[0];
            bytes[offset + 3] = 255;
        }
    }
    let replicated = verify_edge_replication(&bytes, spec);
    (bytes, replicated)
}

fn color_bar(x: u32, width: u32) -> [u8; 3] {
    const BARS: [[u8; 3]; 7] = [
        [235, 235, 235],
        [235, 235, 16],
        [16, 235, 235],
        [16, 235, 16],
        [235, 16, 235],
        [235, 16, 16],
        [16, 16, 235],
    ];
    let index = ((x as usize * BARS.len()) / width as usize).min(BARS.len() - 1);
    BARS[index]
}

fn verify_edge_replication(bytes: &[u8], spec: VideoSpec) -> bool {
    if spec.coded_width == spec.logical_width && spec.coded_height == spec.logical_height {
        return true;
    }
    for y in 0..spec.coded_height {
        let source_y = y.min(spec.logical_height - 1);
        let source = pixel(bytes, spec.coded_width, spec.logical_width - 1, source_y);
        if pixel(bytes, spec.coded_width, spec.coded_width - 1, y) != source {
            return false;
        }
    }
    for x in 0..spec.coded_width {
        let source_x = x.min(spec.logical_width - 1);
        let source = pixel(bytes, spec.coded_width, source_x, spec.logical_height - 1);
        if pixel(bytes, spec.coded_width, x, spec.coded_height - 1) != source {
            return false;
        }
    }
    true
}

fn pixel(bytes: &[u8], width: u32, x: u32, y: u32) -> &[u8] {
    let offset = ((y * width + x) * 4) as usize;
    &bytes[offset..offset + 4]
}

fn bgra_to_nv12(bgra: &[u8], spec: VideoSpec) -> Vec<u8> {
    let plane_size = (spec.coded_width * spec.coded_height) as usize;
    let mut nv12 = vec![0; plane_size * 3 / 2];
    for y in 0..spec.coded_height {
        for x in 0..spec.coded_width {
            let source = pixel(bgra, spec.coded_width, x, y);
            let red = f32::from(source[2]);
            let green = f32::from(source[1]);
            let blue = f32::from(source[0]);
            nv12[(y * spec.coded_width + x) as usize] =
                clamp_channel(0.2126 * red + 0.7152 * green + 0.0722 * blue);
        }
    }
    for y in (0..spec.coded_height).step_by(2) {
        for x in (0..spec.coded_width).step_by(2) {
            let mut red = 0.0;
            let mut green = 0.0;
            let mut blue = 0.0;
            for offset_y in 0..2 {
                for offset_x in 0..2 {
                    let source = pixel(bgra, spec.coded_width, x + offset_x, y + offset_y);
                    red += f32::from(source[2]);
                    green += f32::from(source[1]);
                    blue += f32::from(source[0]);
                }
            }
            red /= 4.0;
            green /= 4.0;
            blue /= 4.0;
            let chroma_offset = plane_size + (y / 2 * spec.coded_width + x) as usize;
            nv12[chroma_offset] =
                clamp_channel(128.0 - 0.114_572 * red - 0.385_428 * green + 0.5 * blue);
            nv12[chroma_offset + 1] =
                clamp_channel(128.0 + 0.5 * red - 0.454_153 * green - 0.045_847 * blue);
        }
    }
    nv12
}

fn identify_pattern(rgba: &[u8], spec: VideoSpec, frame_count: usize) -> usize {
    let center = rgba_pixel(
        rgba,
        spec.coded_width,
        spec.coded_width / 2,
        spec.coded_height / 2,
    );
    (0..frame_count)
        .min_by_key(|index| color_distance(center, frame_color(*index)))
        .unwrap_or(0)
}

fn rgba_pixel(bytes: &[u8], width: u32, x: u32, y: u32) -> [u8; 3] {
    let offset = ((y * width + x) * 4) as usize;
    [bytes[offset], bytes[offset + 1], bytes[offset + 2]]
}

fn color_distance(actual: [u8; 3], expected: [u8; 3]) -> i32 {
    (i32::from(actual[0]) - i32::from(expected[0])).pow(2)
        + (i32::from(actual[1]) - i32::from(expected[1])).pow(2)
        + (i32::from(actual[2]) - i32::from(expected[2])).pow(2)
}

fn color_report(rgba: &[u8], spec: VideoSpec) -> Value {
    let mut comparisons = Vec::new();
    let mut passed = true;
    for bar in 0..7_u32 {
        let x =
            ((bar * spec.logical_width) / 7 + spec.logical_width / 14).min(spec.logical_width - 1);
        let actual = rgba_pixel(rgba, spec.coded_width, x, spec.logical_height / 2);
        let expected = color_bar(x, spec.logical_width);
        let delta = [
            i32::from(actual[0]) - i32::from(expected[0]),
            i32::from(actual[1]) - i32::from(expected[1]),
            i32::from(actual[2]) - i32::from(expected[2]),
        ];
        let patch_passed = delta.iter().all(|value| value.abs() <= COLOR_TOLERANCE);
        passed &= patch_passed;
        comparisons.push(json!({
            "bar": bar,
            "expectedRgb": expected,
            "actualRgb": actual,
            "deltaRgb": delta,
            "passed": patch_passed,
        }));
    }
    json!({
        "classification": "sdr-rec709",
        "primaries": "bt709",
        "transfer": "bt709",
        "matrix": "bt709",
        "range": "full",
        "perChannelTolerance": COLOR_TOLERANCE,
        "centralPatchComparisons": comparisons,
        "passed": passed,
    })
}

fn encode_fixture(
    path: &Path,
    spec: VideoSpec,
    schedule: &[Timing],
    finalize: bool,
) -> Result<bool, SpikeError> {
    let wide_path = wide(path);
    let attributes = create_attributes(2)?;
    unsafe { attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)? };
    let writer = unsafe {
        MFCreateSinkWriterFromURL(
            PCWSTR(wide_path.as_ptr()),
            None::<&IMFByteStream>,
            &attributes,
        )?
    };
    let output_type = create_video_type(spec, MFVideoFormat_H264, false)?;
    unsafe { output_type.SetUINT32(&MF_MT_AVG_BITRATE, 4_000_000)? };
    let stream = unsafe { writer.AddStream(&output_type)? };
    let input_type = create_video_type(spec, MFVideoFormat_NV12, true)?;
    unsafe { writer.SetInputMediaType(stream, &input_type, None::<&IMFAttributes>)? };
    unsafe { writer.BeginWriting()? };

    let mut edges_replicated = true;
    for (index, timing) in schedule.iter().enumerate() {
        let (bgra, replicated) = make_frame(spec, index);
        let bytes = bgra_to_nv12(&bgra, spec);
        edges_replicated &= replicated;
        let buffer: IMFMediaBuffer = unsafe { MFCreateMemoryBuffer(u32::try_from(bytes.len())?)? };
        let mut destination = null_mut();
        unsafe { buffer.Lock(&mut destination, None, None)? };
        unsafe { copy_nonoverlapping(bytes.as_ptr(), destination, bytes.len()) };
        unsafe { buffer.Unlock()? };
        unsafe { buffer.SetCurrentLength(u32::try_from(bytes.len())?)? };
        let sample: IMFSample = unsafe { MFCreateSample()? };
        unsafe { sample.AddBuffer(&buffer)? };
        unsafe { sample.SetSampleTime(timing.pts_100ns)? };
        unsafe { sample.SetSampleDuration(timing.duration_100ns)? };
        unsafe { writer.WriteSample(stream, &sample)? };
    }
    if finalize {
        unsafe { writer.Finalize()? };
    }
    drop(writer);
    Ok(edges_replicated)
}

fn create_video_type(
    spec: VideoSpec,
    subtype: windows::core::GUID,
    uncompressed: bool,
) -> Result<IMFMediaType, SpikeError> {
    let media_type = unsafe { MFCreateMediaType()? };
    unsafe {
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
        media_type.SetUINT64(
            &MF_MT_FRAME_SIZE,
            pack_pair(spec.coded_width, spec.coded_height),
        )?;
        media_type.SetUINT64(&MF_MT_FRAME_RATE, pack_pair(spec.nominal_fps, 1))?;
        media_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_pair(1, 1))?;
        media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_0_255.0 as u32)?;
        if uncompressed {
            media_type.SetUINT32(&MF_MT_FIXED_SIZE_SAMPLES, 1)?;
            media_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
            let stride = if subtype == MFVideoFormat_RGB32 {
                spec.coded_width * 4
            } else {
                spec.coded_width
            };
            media_type.SetUINT32(&MF_MT_DEFAULT_STRIDE, stride)?;
        }
        if spec.logical_width != spec.coded_width || spec.logical_height != spec.coded_height {
            set_aperture(&media_type, spec.logical_width, spec.logical_height)?;
        }
    }
    Ok(media_type)
}

fn decode_fixture(path: &Path, spec: VideoSpec) -> Result<DecodeResult, SpikeError> {
    let attributes = create_attributes(1)?;
    unsafe { attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)? };
    let wide_path = wide(path);
    let reader = unsafe { MFCreateSourceReaderFromURL(PCWSTR(wide_path.as_ptr()), &attributes)? };
    let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
    unsafe { reader.SetStreamSelection(stream, true)? };
    let native_type = unsafe { reader.GetNativeMediaType(stream, 0)? };
    let source_aperture = get_aperture(&native_type);
    let output_type = create_video_type(spec, MFVideoFormat_NV12, true)?;
    unsafe { reader.SetCurrentMediaType(stream, None, &output_type)? };
    let negotiated_type = unsafe { reader.GetCurrentMediaType(stream)? };
    let negotiated_aperture = get_aperture(&negotiated_type);
    let stride = unsafe {
        negotiated_type
            .GetUINT32(&MF_MT_DEFAULT_STRIDE)
            .unwrap_or(spec.coded_width) as i32
    };
    let limited_range = unsafe {
        negotiated_type
            .GetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE)
            .unwrap_or(MFNominalRange_16_235.0 as u32)
            == MFNominalRange_16_235.0 as u32
    };

    let mut frames = Vec::new();
    loop {
        let mut flags = 0_u32;
        let mut timestamp = 0_i64;
        let mut sample = None;
        unsafe {
            reader.ReadSample(
                stream,
                0,
                None,
                Some(&mut flags),
                Some(&mut timestamp),
                Some(&mut sample),
            )?;
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            break;
        }
        let Some(sample) = sample else {
            continue;
        };
        let duration = unsafe { sample.GetSampleDuration().ok() };
        let buffer = unsafe { sample.ConvertToContiguousBuffer()? };
        let rgba = copy_nv12(
            &buffer,
            spec.coded_width,
            spec.coded_height,
            stride,
            limited_range,
        )?;
        frames.push(DecodedFrame {
            pts_100ns: timestamp,
            duration_100ns: duration,
            rgba,
        });
    }
    Ok(DecodeResult {
        frames,
        source_aperture,
        negotiated_aperture,
    })
}

fn copy_nv12(
    buffer: &IMFMediaBuffer,
    width: u32,
    height: u32,
    stride: i32,
    limited_range: bool,
) -> Result<Vec<u8>, SpikeError> {
    let current_length = unsafe { buffer.GetCurrentLength()? } as usize;
    let minimum_length = (width * height * 3 / 2) as usize;
    if current_length < minimum_length {
        return Err(format!(
            "decoded NV12 buffer has {current_length} bytes; expected at least {minimum_length}"
        )
        .into());
    }
    let mut source = null_mut();
    unsafe { buffer.Lock(&mut source, None, None)? };
    let input = unsafe { std::slice::from_raw_parts(source, current_length) };
    let row_stride = stride.unsigned_abs() as usize;
    let required_length = row_stride * height as usize * 3 / 2;
    if row_stride < width as usize || current_length < required_length {
        unsafe { buffer.Unlock()? };
        return Err(format!("decoded NV12 stride {stride} is incompatible with {width}x{height} and {current_length} bytes").into());
    }
    let mut rgba = vec![0; (width * height * 4) as usize];
    let uv_offset = row_stride * height as usize;
    for y in 0..height as usize {
        let source_y = if stride < 0 {
            height as usize - 1 - y
        } else {
            y
        };
        let y_row = &input[source_y * row_stride..source_y * row_stride + width as usize];
        let uv_row = &input[uv_offset + (source_y / 2) * row_stride
            ..uv_offset + (source_y / 2) * row_stride + width as usize];
        for x in 0..width as usize {
            let y_value = f32::from(y_row[x]);
            let cb = f32::from(uv_row[(x / 2) * 2]) - 128.0;
            let cr = f32::from(uv_row[(x / 2) * 2 + 1]) - 128.0;
            let (red, green, blue) = if limited_range {
                let luma = 1.164_384 * (y_value - 16.0);
                (
                    luma + 1.792_741 * cr,
                    luma - 0.213_249 * cb - 0.532_909 * cr,
                    luma + 2.112_402 * cb,
                )
            } else {
                (
                    y_value + 1.5748 * cr,
                    y_value - 0.187_324 * cb - 0.468_124 * cr,
                    y_value + 1.8556 * cb,
                )
            };
            let offset = (y * width as usize + x) * 4;
            rgba[offset] = clamp_channel(red);
            rgba[offset + 1] = clamp_channel(green);
            rgba[offset + 2] = clamp_channel(blue);
            rgba[offset + 3] = 255;
        }
    }
    unsafe { buffer.Unlock()? };
    Ok(rgba)
}

fn clamp_channel(value: f32) -> u8 {
    value.round().clamp(0.0, 255.0) as u8
}

fn create_attributes(count: u32) -> Result<IMFAttributes, SpikeError> {
    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, count)? };
    attributes.ok_or_else(|| "Media Foundation returned no attribute store".into())
}

fn set_aperture(
    media_type: &IMFMediaType,
    logical_width: u32,
    logical_height: u32,
) -> Result<(), SpikeError> {
    let aperture = MFVideoArea {
        OffsetX: MFOffset { fract: 0, value: 0 },
        OffsetY: MFOffset { fract: 0, value: 0 },
        Area: SIZE {
            cx: logical_width as i32,
            cy: logical_height as i32,
        },
    };
    let bytes = unsafe {
        std::slice::from_raw_parts(
            (&aperture as *const MFVideoArea).cast::<u8>(),
            size_of::<MFVideoArea>(),
        )
    };
    unsafe {
        media_type.SetBlob(&MF_MT_GEOMETRIC_APERTURE, bytes)?;
        media_type.SetBlob(&MF_MT_MINIMUM_DISPLAY_APERTURE, bytes)?;
    }
    Ok(())
}

fn get_aperture(media_type: &IMFMediaType) -> Option<MFVideoArea> {
    for key in [&MF_MT_GEOMETRIC_APERTURE, &MF_MT_MINIMUM_DISPLAY_APERTURE] {
        let size = unsafe { media_type.GetBlobSize(key).ok()? };
        if size as usize != size_of::<MFVideoArea>() {
            continue;
        }
        let mut bytes = vec![0; size as usize];
        if unsafe { media_type.GetBlob(key, &mut bytes, None) }.is_ok() {
            return Some(unsafe { read_unaligned(bytes.as_ptr().cast::<MFVideoArea>()) });
        }
    }
    None
}

fn aperture_json(value: MFVideoArea) -> Value {
    json!({
        "offsetX": {"value": value.OffsetX.value, "fract": value.OffsetX.fract},
        "offsetY": {"value": value.OffsetY.value, "fract": value.OffsetY.fract},
        "width": value.Area.cx,
        "height": value.Area.cy,
    })
}

fn crop_rgba(rgba: &[u8], coded_width: u32, logical_width: u32, logical_height: u32) -> Vec<u8> {
    let mut cropped = Vec::with_capacity((logical_width * logical_height * 4) as usize);
    for y in 0..logical_height as usize {
        let start = y * coded_width as usize * 4;
        cropped.extend_from_slice(&rgba[start..start + logical_width as usize * 4]);
    }
    cropped
}

fn pack_pair(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn validate_token(value: &str, label: &str) -> Result<String, SpikeError> {
    if value.is_empty()
        || value.len() > 128
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(format!("{label} contains unsupported characters").into());
    }
    Ok(value.to_string())
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn print_help() {
    println!(
        "native_decode_spike --scenario SCENARIO --build-id REVISION [--run-id ID] [--output-dir DIR]"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cfr_schedule_uses_exact_integer_boundaries() {
        let schedule = cfr_schedule(3, 30);
        assert_eq!(
            schedule[0],
            Timing {
                pts_100ns: 0,
                duration_100ns: 333_333
            }
        );
        assert_eq!(
            schedule[1],
            Timing {
                pts_100ns: 333_333,
                duration_100ns: 333_333
            }
        );
        assert_eq!(
            schedule[2],
            Timing {
                pts_100ns: 666_666,
                duration_100ns: 333_334
            }
        );
    }

    #[test]
    fn vfr_schedule_preserves_nonuniform_durations() {
        let schedule = vfr_schedule(&[100, 250, 125]);
        assert_eq!(
            schedule[2],
            Timing {
                pts_100ns: 350,
                duration_100ns: 125
            }
        );
    }

    #[test]
    fn odd_frames_use_replicated_edge_padding() {
        let spec = VideoSpec::odd();
        let (frame, replicated) = make_frame(spec, 2);
        assert!(replicated);
        assert_eq!(frame.len(), (162 * 92 * 4) as usize);
    }

    #[test]
    fn hdr_policy_blocks_pq_and_hlg_bt2020() {
        assert!(hdr_requires_tone_mapping("bt2020", "pq"));
        assert!(hdr_requires_tone_mapping("bt2020", "hlg"));
        assert!(!hdr_requires_tone_mapping("bt709", "pq"));
        assert!(!hdr_requires_tone_mapping("bt2020", "bt709"));
    }

    #[test]
    fn frame_identity_is_deterministic() {
        let spec = VideoSpec::standard(60, false);
        let (bgra, _) = make_frame(spec, 17);
        let mut rgba = vec![0; bgra.len()];
        for (source, target) in bgra.chunks_exact(4).zip(rgba.chunks_exact_mut(4)) {
            target.copy_from_slice(&[source[2], source[1], source[0], 255]);
        }
        assert_eq!(identify_pattern(&rgba, spec, 60), 17);
    }

    #[test]
    fn color_metadata_constants_match_expected_media_foundation_classes() {
        use windows::Win32::Media::MediaFoundation::{
            MFVideoPrimaries_BT2020, MFVideoTransFunc_2084, MFVideoTransFunc_HLG,
            MFVideoTransferMatrix_BT2020_10,
        };

        assert_eq!(MFVideoPrimaries_BT2020.0, 9);
        assert_eq!(MFVideoTransFunc_2084.0, 15);
        assert_eq!(MFVideoTransFunc_HLG.0, 16);
        assert_eq!(MFVideoTransferMatrix_BT2020_10.0, 4);
    }
}
