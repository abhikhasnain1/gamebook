#![cfg(target_os = "windows")]

use std::{
    env,
    error::Error,
    fs,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr::{copy_nonoverlapping, null_mut},
    time::Instant,
};

use serde_json::json;
use windows::{
    core::PCWSTR,
    Win32::{
        Media::MediaFoundation::{
            IMFAttributes, IMFByteStream, IMFMediaBuffer, IMFMediaType, IMFSample,
            MFCreateAttributes, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
            MFCreateSinkWriterFromURL, MFMediaType_Video, MFNominalRange_16_235, MFShutdown,
            MFStartup, MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoInterlace_Progressive,
            MFVideoPrimaries_BT709, MFVideoTransFunc_709, MFVideoTransferMatrix_BT709,
            MFSTARTUP_FULL, MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE,
            MF_MT_FIXED_SIZE_SAMPLES, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
            MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE, MF_MT_TRANSFER_FUNCTION,
            MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES, MF_MT_YUV_MATRIX,
            MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_VERSION,
        },
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
    },
};

type FixtureError = Box<dyn Error + Send + Sync>;

const TICKS_PER_SECOND: i64 = 10_000_000;

struct Options {
    width: u32,
    height: u32,
    fps: u32,
    duration_seconds: u32,
    output: PathBuf,
    report: PathBuf,
    build_id: String,
}

impl Options {
    fn parse(args: &[String]) -> Result<Self, FixtureError> {
        let mut width = None;
        let mut height = None;
        let mut fps = 60;
        let mut duration_seconds = 30;
        let mut output = None;
        let mut report = None;
        let mut build_id = None;
        let mut index = 1;
        while index < args.len() {
            let value = args.get(index + 1).ok_or("Missing option value")?;
            match args[index].as_str() {
                "--width" => width = Some(value.parse()?),
                "--height" => height = Some(value.parse()?),
                "--fps" => fps = value.parse()?,
                "--duration" => duration_seconds = value.parse()?,
                "--output" => output = Some(PathBuf::from(value)),
                "--report" => report = Some(PathBuf::from(value)),
                "--build-id" => build_id = Some(value.clone()),
                option => return Err(format!("Unknown option: {option}").into()),
            }
            index += 2;
        }
        let width = width.ok_or("--width is required")?;
        let height = height.ok_or("--height is required")?;
        if width < 16 || height < 16 || width % 2 != 0 || height % 2 != 0 {
            return Err("Dimensions must be even integers of at least 16 pixels".into());
        }
        if fps != 60 || duration_seconds != 30 {
            return Err("The rendering gate fixture is fixed at 60 FPS for 30 seconds".into());
        }
        let build_id = build_id.ok_or("--build-id is required")?;
        if !(7..=64).contains(&build_id.len())
            || !build_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("--build-id must be a 7-64 character hexadecimal revision".into());
        }
        Ok(Self {
            width,
            height,
            fps,
            duration_seconds,
            output: output.ok_or("--output is required")?,
            report: report.ok_or("--report is required")?,
            build_id,
        })
    }
}

struct ComGuard;

impl ComGuard {
    fn initialize() -> Result<Self, FixtureError> {
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
    fn initialize() -> Result<Self, FixtureError> {
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL)? };
        Ok(Self)
    }
}

impl Drop for MediaFoundationGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
        }
    }
}

fn main() -> Result<(), FixtureError> {
    let options = Options::parse(&env::args().collect::<Vec<_>>())?;
    if let Some(parent) = options.output.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Some(parent) = options.report.parent() {
        fs::create_dir_all(parent)?;
    }
    if options.output.exists() {
        fs::remove_file(&options.output)?;
    }

    let started = Instant::now();
    let _com = ComGuard::initialize()?;
    let _media_foundation = MediaFoundationGuard::initialize()?;
    encode(&options)?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let frame_count = options.fps * options.duration_seconds;
    let report = json!({
        "schema": "gamebook.media-render-fixture.v1",
        "applicationVersion": env!("CARGO_PKG_VERSION"),
        "applicationBuild": options.build_id,
        "width": options.width,
        "height": options.height,
        "frameRate": options.fps,
        "durationSeconds": options.duration_seconds,
        "submittedFrames": frame_count,
        "expectedDuration100ns": i64::from(options.duration_seconds) * TICKS_PER_SECOND,
        "outputBytes": fs::metadata(&options.output)?.len(),
        "generationMs": elapsed_ms,
        "color": "sdr-rec709-limited",
        "audio": false,
        "networkAccess": false,
        "projectWrites": false,
        "source": "deterministic-full-resolution-nv12",
        "output": format!("artifact:{}", options.output.file_name().and_then(|name| name.to_str()).unwrap_or("fixture.mp4")),
    });
    fs::write(&options.report, serde_json::to_vec_pretty(&report)?)?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

fn encode(options: &Options) -> Result<(), FixtureError> {
    let wide_path = wide(&options.output);
    let attributes = create_attributes(2)?;
    unsafe { attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)? };
    let writer = unsafe {
        MFCreateSinkWriterFromURL(
            PCWSTR(wide_path.as_ptr()),
            None::<&IMFByteStream>,
            &attributes,
        )?
    };
    let output_type = create_video_type(options, MFVideoFormat_H264, false)?;
    unsafe { output_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate(options.width, options.height))? };
    let stream = unsafe { writer.AddStream(&output_type)? };
    let input_type = create_video_type(options, MFVideoFormat_NV12, true)?;
    unsafe { writer.SetInputMediaType(stream, &input_type, None::<&IMFAttributes>)? };
    unsafe { writer.BeginWriting()? };

    let frame_duration = TICKS_PER_SECOND / i64::from(options.fps);
    let frame_count = options.fps * options.duration_seconds;
    let mut frame = make_nv12_pattern(options.width, options.height);
    for index in 0..frame_count {
        animate_pattern(&mut frame, options.width, options.height, index);
        write_sample(
            &writer,
            stream,
            &frame,
            i64::from(index) * frame_duration,
            frame_duration,
        )?;
    }
    unsafe { writer.Finalize()? };
    Ok(())
}

fn make_nv12_pattern(width: u32, height: u32) -> Vec<u8> {
    let plane_size = (width * height) as usize;
    let mut bytes = vec![128_u8; plane_size * 3 / 2];
    for y in 0..height {
        for x in 0..width {
            let checker = ((x / 64) + (y / 64)) % 2;
            bytes[(y * width + x) as usize] = if checker == 0 { 48 } else { 192 };
        }
    }
    for y in (0..height).step_by(2) {
        for x in (0..width).step_by(2) {
            let offset = plane_size + (y / 2 * width + x) as usize;
            bytes[offset] = 90 + ((x / 128) % 4) as u8 * 20;
            bytes[offset + 1] = 166 - ((y / 128) % 4) as u8 * 20;
        }
    }
    bytes
}

fn animate_pattern(bytes: &mut [u8], width: u32, height: u32, frame: u32) {
    let stripe_width = 32_u32.min(width);
    let stripe_start = (frame * 19) % width;
    for y in 0..height {
        for offset in 0..stripe_width {
            let x = (stripe_start + offset) % width;
            bytes[(y * width + x) as usize] = 235;
        }
    }
}

fn write_sample(
    writer: &windows::Win32::Media::MediaFoundation::IMFSinkWriter,
    stream: u32,
    bytes: &[u8],
    pts: i64,
    duration: i64,
) -> Result<(), FixtureError> {
    let buffer: IMFMediaBuffer = unsafe { MFCreateMemoryBuffer(u32::try_from(bytes.len())?)? };
    let mut destination = null_mut();
    unsafe { buffer.Lock(&mut destination, None, None)? };
    unsafe { copy_nonoverlapping(bytes.as_ptr(), destination, bytes.len()) };
    unsafe { buffer.Unlock()? };
    unsafe { buffer.SetCurrentLength(u32::try_from(bytes.len())?)? };
    let sample: IMFSample = unsafe { MFCreateSample()? };
    unsafe { sample.AddBuffer(&buffer)? };
    unsafe { sample.SetSampleTime(pts)? };
    unsafe { sample.SetSampleDuration(duration)? };
    unsafe { writer.WriteSample(stream, &sample)? };
    Ok(())
}

fn create_video_type(
    options: &Options,
    subtype: windows::core::GUID,
    uncompressed: bool,
) -> Result<IMFMediaType, FixtureError> {
    let media_type = unsafe { MFCreateMediaType()? };
    unsafe {
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
        media_type.SetUINT64(&MF_MT_FRAME_SIZE, pack_pair(options.width, options.height))?;
        media_type.SetUINT64(&MF_MT_FRAME_RATE, pack_pair(options.fps, 1))?;
        media_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_pair(1, 1))?;
        media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
        if uncompressed {
            media_type.SetUINT32(&MF_MT_FIXED_SIZE_SAMPLES, 1)?;
            media_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
        }
    }
    Ok(media_type)
}

fn create_attributes(capacity: u32) -> Result<IMFAttributes, FixtureError> {
    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, capacity)? };
    attributes.ok_or_else(|| "Media Foundation did not create attributes".into())
}

fn bitrate(width: u32, height: u32) -> u32 {
    let pixels = u64::from(width) * u64::from(height);
    u32::try_from((pixels * 8).clamp(8_000_000, 40_000_000)).unwrap_or(40_000_000)
}

fn pack_pair(high: u32, low: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
