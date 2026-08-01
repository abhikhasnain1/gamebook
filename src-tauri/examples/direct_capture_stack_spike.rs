#![cfg(target_os = "windows")]

use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::ptr::{copy_nonoverlapping, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rayon::prelude::*;
use serde_json::{json, Value};
use windows::core::{factory, IInspectable, Interface, BOOL, PCWSTR};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{
    COLORREF, HINSTANCE, HMODULE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, InvalidateRect,
    MonitorFromPoint, MonitorFromWindow, UpdateWindow, HGDIOBJ, MONITOR_DEFAULTTONEAREST,
    PAINTSTRUCT,
};
use windows::Win32::Media::MediaFoundation::{
    IMFAttributes, IMFByteStream, IMFMediaBuffer, IMFMediaType, IMFSample, IMFSinkWriter,
    MFCreateAttributes, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
    MFCreateSinkWriterFromURL, MFCreateSourceReaderFromURL, MFMediaType_Video,
    MFNominalRange_0_255, MFShutdown, MFStartup, MFVideoFormat_H264, MFVideoFormat_NV12,
    MFVideoInterlace_Progressive, MFVideoPrimaries_BT709, MFVideoTransFunc_709,
    MFVideoTransferMatrix_BT709, MFSTARTUP_FULL, MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AVG_BITRATE,
    MF_MT_DEFAULT_STRIDE, MF_MT_FIXED_SIZE_SAMPLES, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE,
    MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
    MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES, MF_MT_YUV_MATRIX,
    MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SOURCE_READERF_ENDOFSTREAM,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_VERSION,
};
use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnumWindows, GetClientRect,
    GetCursorPos, GetMessageW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    IsWindowVisible, PostMessageW, PostQuitMessage, RegisterClassW, SetTimer,
    SetWindowDisplayAffinity, ShowWindow, TranslateMessage, CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT,
    MSG, SW_SHOW, WDA_EXCLUDEFROMCAPTURE, WINDOW_EX_STYLE, WM_CLOSE, WM_DESTROY, WM_PAINT,
    WM_TIMER, WNDCLASSW, WS_OVERLAPPEDWINDOW,
};

const FIXTURE_TITLE_PREFIX: &str = "Gamebook Native Capture Fixture";
const FIXTURE_HOST_TITLE: &str = "Gamebook Native Capture Fixture - Direct Binding Host";
const TICKS_PER_SECOND: i64 = 10_000_000;
static FIXTURE_FRAME: AtomicU64 = AtomicU64::new(0);

type SpikeError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Target {
    MonitorUnderPointer,
    ControlledFixtureWindow,
    FixtureMonitor,
}

impl Target {
    fn parse(value: &str) -> Result<Self, SpikeError> {
        match value {
            "monitor-under-pointer" => Ok(Self::MonitorUnderPointer),
            "controlled-fixture-window" => Ok(Self::ControlledFixtureWindow),
            "fixture-monitor" => Ok(Self::FixtureMonitor),
            _ => Err(format!("Unsupported target: {value}").into()),
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::MonitorUnderPointer => "monitor-under-pointer",
            Self::ControlledFixtureWindow => "controlled-fixture-window",
            Self::FixtureMonitor => "fixture-monitor",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Scenario {
    Capture,
    Cancel,
    SourceClose,
    InitializationFailure,
    EncoderFailure,
    GpuFailure,
    StorageFailure,
    FinalizationFailure,
    DecoderFailure,
    CaptureInterrupt,
    PromotionInterrupt,
    RecoveryCheck,
    ProtectedContent,
    HudExclusion,
    DeviceLoss,
}

impl Scenario {
    fn parse(value: &str) -> Result<Self, SpikeError> {
        match value {
            "capture" => Ok(Self::Capture),
            "cancel" => Ok(Self::Cancel),
            "source-close" => Ok(Self::SourceClose),
            "initialization-failure" => Ok(Self::InitializationFailure),
            "encoder-failure" => Ok(Self::EncoderFailure),
            "gpu-failure" => Ok(Self::GpuFailure),
            "storage-failure" => Ok(Self::StorageFailure),
            "finalization-failure" => Ok(Self::FinalizationFailure),
            "decoder-failure" => Ok(Self::DecoderFailure),
            "capture-interrupt" => Ok(Self::CaptureInterrupt),
            "promotion-interrupt" => Ok(Self::PromotionInterrupt),
            "recovery-check" => Ok(Self::RecoveryCheck),
            "protected-content" => Ok(Self::ProtectedContent),
            "hud-exclusion" => Ok(Self::HudExclusion),
            "device-loss" => Ok(Self::DeviceLoss),
            _ => Err(format!("Unsupported scenario: {value}").into()),
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Cancel => "cancel",
            Self::SourceClose => "source-close",
            Self::InitializationFailure => "initialization-failure",
            Self::EncoderFailure => "encoder-failure",
            Self::GpuFailure => "gpu-failure",
            Self::StorageFailure => "storage-failure",
            Self::FinalizationFailure => "finalization-failure",
            Self::DecoderFailure => "decoder-failure",
            Self::CaptureInterrupt => "capture-interrupt",
            Self::PromotionInterrupt => "promotion-interrupt",
            Self::RecoveryCheck => "recovery-check",
            Self::ProtectedContent => "protected-content",
            Self::HudExclusion => "hud-exclusion",
            Self::DeviceLoss => "device-loss",
        }
    }

    const fn expected_failure_outcome(self) -> Option<&'static str> {
        match self {
            Self::InitializationFailure => Some("injected-initialization-failure"),
            Self::EncoderFailure => Some("injected-encoder-failure"),
            Self::GpuFailure => Some("injected-gpu-failure"),
            Self::StorageFailure => Some("injected-storage-failure"),
            Self::FinalizationFailure => Some("injected-finalization-failure"),
            Self::DecoderFailure => Some("injected-decoder-failure"),
            Self::Capture
            | Self::Cancel
            | Self::SourceClose
            | Self::CaptureInterrupt
            | Self::PromotionInterrupt
            | Self::RecoveryCheck
            | Self::ProtectedContent
            | Self::HudExclusion
            | Self::DeviceLoss => None,
        }
    }
}

#[derive(Debug)]
struct Options {
    build_id: String,
    run_id: String,
    output_dir: PathBuf,
    target: Target,
    scenario: Scenario,
    duration_seconds: u64,
    frame_rate: u32,
    countdown_seconds: u64,
    input_run_id: Option<String>,
}

impl Options {
    fn parse(args: &[String]) -> Result<Self, SpikeError> {
        let mut build_id = None;
        let mut run_id = None;
        let mut output_dir = PathBuf::from("src-tauri/target/direct-capture-stack-spike");
        let mut target = Target::MonitorUnderPointer;
        let mut scenario = Scenario::Capture;
        let mut duration_seconds = 30;
        let mut frame_rate = 60;
        let mut countdown_seconds = 3;
        let mut input_run_id = None;
        let mut index = 1;
        while index < args.len() {
            let value = args.get(index + 1).ok_or("Missing option value")?;
            match args[index].as_str() {
                "--build-id" => build_id = Some(value.clone()),
                "--run-id" => run_id = Some(value.clone()),
                "--output-dir" => output_dir = PathBuf::from(value),
                "--target" => target = Target::parse(value)?,
                "--scenario" => scenario = Scenario::parse(value)?,
                "--duration" => duration_seconds = value.parse()?,
                "--frame-rate" => frame_rate = value.parse()?,
                "--countdown" => countdown_seconds = value.parse()?,
                "--input-run-id" => input_run_id = Some(value.clone()),
                unknown => return Err(format!("Unknown option: {unknown}").into()),
            }
            index += 2;
        }
        let build_id = build_id.ok_or("--build-id is required")?;
        let run_id = run_id.ok_or("--run-id is required")?;
        if !(7..=64).contains(&build_id.len())
            || !build_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("--build-id must be a 7-64 character hexadecimal revision".into());
        }
        validate_run_id(&run_id, "--run-id")?;
        if let Some(input_run_id) = input_run_id.as_deref() {
            validate_run_id(input_run_id, "--input-run-id")?;
        }
        if scenario == Scenario::RecoveryCheck && input_run_id.is_none() {
            return Err("--input-run-id is required for recovery-check".into());
        }
        if !(1..=300).contains(&duration_seconds) {
            return Err("--duration must be between 1 and 300 seconds".into());
        }
        if !matches!(frame_rate, 30 | 60) {
            return Err("--frame-rate must be 30 or 60".into());
        }
        if countdown_seconds > 30 {
            return Err("--countdown must be at most 30 seconds".into());
        }
        Ok(Self {
            build_id,
            run_id,
            output_dir,
            target,
            scenario,
            duration_seconds,
            frame_rate,
            countdown_seconds,
            input_run_id,
        })
    }
}

fn validate_run_id(value: &str, option: &str) -> Result<(), SpikeError> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(format!(
            "{option} must contain only ASCII letters, numbers, hyphens, or underscores"
        )
        .into());
    }
    Ok(())
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

struct D3dDevices {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    direct3d: IDirect3DDevice,
}

fn create_d3d_devices() -> Result<D3dDevices, SpikeError> {
    let levels = [
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    ];
    let mut device = None;
    let mut context = None;
    let mut selected = D3D_FEATURE_LEVEL::default();
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut selected),
            Some(&mut context),
        )?;
    }
    if selected.0 < D3D_FEATURE_LEVEL_11_0.0 {
        return Err("Direct3D feature level 11.0 is required".into());
    }
    let device = device.ok_or("D3D11 returned no device")?;
    let dxgi: IDXGIDevice = device.cast()?;
    let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? };
    let direct3d: IDirect3DDevice = inspectable.cast()?;
    Ok(D3dDevices {
        device,
        context: context.ok_or("D3D11 returned no immediate context")?,
        direct3d,
    })
}

fn capture_item(target: Target) -> Result<GraphicsCaptureItem, SpikeError> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    match target {
        Target::MonitorUnderPointer => {
            let mut point = POINT::default();
            unsafe { GetCursorPos(&mut point)? };
            let monitor = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
            Ok(unsafe { interop.CreateForMonitor(monitor)? })
        }
        Target::ControlledFixtureWindow => {
            let window = fixture_window()?;
            Ok(unsafe { interop.CreateForWindow(window)? })
        }
        Target::FixtureMonitor => {
            let window = fixture_window()?;
            let monitor = unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST) };
            Ok(unsafe { interop.CreateForMonitor(monitor)? })
        }
    }
}

struct FixtureProcess {
    child: Option<Child>,
    closer: Option<std::thread::JoinHandle<()>>,
    exited: Arc<AtomicBool>,
}

impl FixtureProcess {
    fn spawn(exclude_from_capture: bool) -> Result<Self, SpikeError> {
        let mut command = Command::new(env::current_exe()?);
        command.arg("--fixture-host");
        command.stdin(Stdio::piped());
        if exclude_from_capture {
            command.arg("--exclude-from-capture");
        }
        let child = command.spawn()?;
        let process = Self {
            child: Some(child),
            closer: None,
            exited: Arc::new(AtomicBool::new(false)),
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if fixture_window().is_ok() {
                return Ok(process);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("The controlled fixture process did not create its window".into())
    }

    fn close_after(&mut self, delay: Duration) -> Result<(), SpikeError> {
        let mut child = self.child.take().ok_or("Fixture process is not running")?;
        let window = fixture_window()?.0 as isize;
        let exited = self.exited.clone();
        self.closer = Some(std::thread::spawn(move || {
            std::thread::sleep(delay);
            let window = HWND(window as *mut core::ffi::c_void);
            let _ = unsafe { PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0)) };
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                if child.try_wait().ok().flatten().is_some() {
                    exited.store(true, Ordering::Relaxed);
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            let _ = child.kill();
            let _ = child.wait();
            exited.store(true, Ordering::Relaxed);
        }));
        Ok(())
    }

    fn has_exited(&self) -> bool {
        self.exited.load(Ordering::Relaxed)
    }
}

impl Drop for FixtureProcess {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
            self.exited.store(true, Ordering::Relaxed);
        }
        if let Some(closer) = self.closer.take() {
            let _ = closer.join();
        }
    }
}

unsafe extern "system" fn fixture_window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_TIMER => {
            let frame = FIXTURE_FRAME.fetch_add(1, Ordering::Relaxed);
            if frame > 15_000 {
                let _ = unsafe { DestroyWindow(window) };
            } else {
                let _ = unsafe { InvalidateRect(Some(window), None, false) };
            }
            LRESULT(0)
        }
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let device = unsafe { BeginPaint(window, &mut paint) };
            let mut client = RECT::default();
            let _ = unsafe { GetClientRect(window, &mut client) };
            let frame = FIXTURE_FRAME.load(Ordering::Relaxed);
            let background_color = if frame.is_multiple_of(2) {
                COLORREF(0x0020_2040)
            } else {
                COLORREF(0x0040_2020)
            };
            let background = unsafe { CreateSolidBrush(background_color) };
            unsafe { FillRect(device, &client, background) };
            let width = (client.right - client.left).max(1);
            let stripe_x = i32::try_from(frame % u64::try_from(width).unwrap_or(1)).unwrap_or(0);
            let stripe_rect = RECT {
                left: stripe_x,
                top: 0,
                right: (stripe_x + 96).min(client.right),
                bottom: client.bottom,
            };
            let stripe = unsafe { CreateSolidBrush(COLORREF(0x0000_D0F0)) };
            unsafe { FillRect(device, &stripe_rect, stripe) };
            unsafe {
                let _ = DeleteObject(HGDIOBJ(background.0));
                let _ = DeleteObject(HGDIOBJ(stripe.0));
                let _ = EndPaint(window, &paint);
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}

struct TimerResolutionGuard;

impl TimerResolutionGuard {
    fn one_millisecond() -> Result<Self, SpikeError> {
        if unsafe { timeBeginPeriod(1) } != 0 {
            return Err("Unable to request a 1 ms fixture timer period".into());
        }
        Ok(Self)
    }
}

impl Drop for TimerResolutionGuard {
    fn drop(&mut self) {
        let _ = unsafe { timeEndPeriod(1) };
    }
}

fn run_fixture_host(exclude_from_capture: bool) -> Result<(), SpikeError> {
    let _timer_resolution = TimerResolutionGuard::one_millisecond()?;
    let class_name: Vec<u16> = "GamebookDirectCaptureFixtureClass"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let title: Vec<u16> = FIXTURE_HOST_TITLE
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let module = unsafe { GetModuleHandleW(None)? };
    let instance = HINSTANCE(module.0);
    let window_class = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(fixture_window_proc),
        hInstance: instance,
        lpszClassName: PCWSTR(class_name.as_ptr()),
        ..Default::default()
    };
    if unsafe { RegisterClassW(&window_class) } == 0 {
        return Err("Unable to register the controlled fixture window class".into());
    }
    let window = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1280,
            720,
            None,
            None,
            Some(instance),
            None,
        )?
    };
    let window_handle = window.0 as isize;
    std::thread::spawn(move || {
        let mut input = std::io::stdin();
        let mut sink = Vec::new();
        let _ = input.read_to_end(&mut sink);
        let window = HWND(window_handle as *mut core::ffi::c_void);
        let _ = unsafe { PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0)) };
    });
    unsafe {
        if exclude_from_capture {
            SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE)?;
        }
        let _ = ShowWindow(window, SW_SHOW);
        let _ = UpdateWindow(window);
        SetTimer(Some(window), 1, 8, None);
    }
    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(())
}

fn fixture_window() -> Result<HWND, SpikeError> {
    unsafe extern "system" fn collect_window(window: HWND, state: LPARAM) -> BOOL {
        let windows = unsafe { &mut *(state.0 as *mut Vec<HWND>) };
        windows.push(window);
        BOOL(1)
    }

    let mut windows = Vec::new();
    unsafe {
        EnumWindows(
            Some(collect_window),
            LPARAM((&mut windows as *mut Vec<HWND>) as isize),
        )?;
    }
    let mut best: Option<(HWND, i64, bool)> = None;
    for window in windows {
        if !unsafe { IsWindowVisible(window) }.as_bool() {
            continue;
        }
        let title_length = unsafe { GetWindowTextLengthW(window) };
        if title_length <= 0 {
            continue;
        }
        let mut title = vec![0_u16; usize::try_from(title_length)? + 1];
        let copied = unsafe { GetWindowTextW(window, &mut title) };
        if copied <= 0 {
            continue;
        }
        let title = String::from_utf16_lossy(&title[..usize::try_from(copied)?]);
        if !title.starts_with(FIXTURE_TITLE_PREFIX) {
            continue;
        }
        let mut rect = RECT::default();
        if unsafe { GetWindowRect(window, &mut rect) }.is_err() {
            continue;
        }
        let width = i64::from((rect.right - rect.left).max(0));
        let height = i64::from((rect.bottom - rect.top).max(0));
        let area = width * height;
        let owned = title == FIXTURE_HOST_TITLE;
        if best.is_none_or(|(_, best_area, best_owned)| {
            (owned && !best_owned) || (owned == best_owned && area > best_area)
        }) {
            best = Some((window, area, owned));
        }
    }
    let (window, area, _) = best.ok_or("The controlled fixture window is not open")?;
    if area < 640 * 360 {
        return Err("The controlled fixture window is too small for throughput validation".into());
    }
    Ok(window)
}

#[derive(Debug)]
struct FrameData {
    source_ticks: i64,
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}

struct ReadbackState {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    staging: Option<ID3D11Texture2D>,
    staging_size: (u32, u32),
    sender: SyncSender<FrameData>,
    stop: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
    error: Arc<Mutex<Option<String>>>,
}

#[allow(clippy::non_send_fields_in_send_ty)]
unsafe impl Send for ReadbackState {}

impl ReadbackState {
    fn read_frame(&mut self, frame_pool: &Direct3D11CaptureFramePool) -> Result<(), SpikeError> {
        if self.stop.load(Ordering::Relaxed) {
            return Ok(());
        }
        let frame = frame_pool.TryGetNextFrame()?;
        let size = frame.ContentSize()?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err("Windows Graphics Capture returned an invalid content size".into());
        }
        let width = u32::try_from(size.Width)?;
        let height = u32::try_from(size.Height)?;
        let surface = frame.Surface()?;
        let access = surface.cast::<IDirect3DDxgiInterfaceAccess>()?;
        let texture = unsafe { access.GetInterface::<ID3D11Texture2D>()? };
        let mut texture_desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut texture_desc) };
        if width > texture_desc.Width || height > texture_desc.Height {
            return Err("Capture content exceeds the backing texture".into());
        }
        if self.staging.is_none() || self.staging_size != (texture_desc.Width, texture_desc.Height)
        {
            self.staging = Some(create_staging_texture(
                &self.device,
                texture_desc.Width,
                texture_desc.Height,
            )?);
            self.staging_size = (texture_desc.Width, texture_desc.Height);
        }
        let staging = self.staging.as_ref().ok_or("Missing staging texture")?;
        unsafe { self.context.CopyResource(staging, &texture) };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context
                .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        }
        let row_bytes = usize::try_from(width)? * 4;
        let mut bgra = vec![0_u8; row_bytes * usize::try_from(height)?];
        for row in 0..usize::try_from(height)? {
            let source =
                unsafe { (mapped.pData as *const u8).add(row * usize::try_from(mapped.RowPitch)?) };
            let destination = unsafe { bgra.as_mut_ptr().add(row * row_bytes) };
            unsafe { copy_nonoverlapping(source, destination, row_bytes) };
        }
        unsafe { self.context.Unmap(staging, 0) };
        let data = FrameData {
            source_ticks: frame.SystemRelativeTime()?.Duration,
            width,
            height,
            bgra,
        };
        if self.sender.try_send(data).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }
}

fn create_staging_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<ID3D11Texture2D, SpikeError> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture))? };
    texture.ok_or_else(|| "D3D11 returned no staging texture".into())
}

struct CaptureSession {
    item: GraphicsCaptureItem,
    frame_pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    frame_token: i64,
    closed_token: i64,
    stop: Arc<AtomicBool>,
}

impl CaptureSession {
    fn start(
        devices: &D3dDevices,
        item: GraphicsCaptureItem,
        sender: SyncSender<FrameData>,
        error: Arc<Mutex<Option<String>>>,
        dropped: Arc<AtomicU64>,
    ) -> Result<Self, SpikeError> {
        if !GraphicsCaptureSession::IsSupported()? {
            return Err("Windows Graphics Capture is not supported".into());
        }
        let size = item.Size()?;
        println!("Resolved capture target: {}x{}", size.Width, size.Height);
        let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &devices.direct3d,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )?;
        let session = frame_pool.CreateCaptureSession(&item)?;
        session.SetIsCursorCaptureEnabled(false)?;
        let stop = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(ReadbackState {
            device: devices.device.clone(),
            context: devices.context.clone(),
            staging: None,
            staging_size: (0, 0),
            sender,
            stop: stop.clone(),
            dropped,
            error: error.clone(),
        }));
        let frame_token = frame_pool.FrameArrived(&TypedEventHandler::<
            Direct3D11CaptureFramePool,
            IInspectable,
        >::new({
            let state = state.clone();
            move |pool, _| {
                let pool = pool
                    .as_ref()
                    .expect("FrameArrived parameter was unexpectedly empty");
                let mut state = state.lock().expect("capture state mutex poisoned");
                if let Err(capture_error) = state.read_frame(pool) {
                    *state.error.lock().expect("capture error mutex poisoned") =
                        Some(capture_error.to_string());
                    state.stop.store(true, Ordering::Relaxed);
                }
                Ok(())
            }
        }))?;
        let closed_token = item.Closed(
            &TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new({
                let stop = stop.clone();
                move |_, _| {
                    stop.store(true, Ordering::Relaxed);
                    Ok(())
                }
            }),
        )?;
        session.StartCapture()?;
        Ok(Self {
            item,
            frame_pool,
            session,
            frame_token,
            closed_token,
            stop,
        })
    }

    fn source_closed(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.frame_pool.RemoveFrameArrived(self.frame_token);
        let _ = self.item.RemoveClosed(self.closed_token);
        let _ = self.session.Close();
        let _ = self.frame_pool.Close();
    }
}

struct Nv12Writer {
    writer: IMFSinkWriter,
    stream: u32,
    width: u32,
    height: u32,
}

impl Nv12Writer {
    fn create(path: &Path, width: u32, height: u32, frame_rate: u32) -> Result<Self, SpikeError> {
        let width = even(width);
        let height = even(height);
        let attributes =
            create_attributes(2).map_err(|error| format!("encoder-attributes: {error}"))?;
        unsafe { attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1) }
            .map_err(|error| format!("encoder-hardware-transform-attribute: {error}"))?;
        let wide_path = wide(path);
        let writer = unsafe {
            MFCreateSinkWriterFromURL(
                PCWSTR(wide_path.as_ptr()),
                None::<&IMFByteStream>,
                &attributes,
            )
            .map_err(|error| format!("encoder-create-writer: {error}"))?
        };
        let output = create_video_type(width, height, frame_rate, MFVideoFormat_H264, false)
            .map_err(|error| format!("encoder-output-media-type: {error}"))?;
        unsafe { output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate(width, height)) }
            .map_err(|error| format!("encoder-bitrate: {error}"))?;
        let stream = unsafe { writer.AddStream(&output) }
            .map_err(|error| format!("encoder-add-stream: {error}"))?;
        let input = create_video_type(width, height, frame_rate, MFVideoFormat_NV12, true)
            .map_err(|error| format!("encoder-input-media-type: {error}"))?;
        unsafe { writer.SetInputMediaType(stream, &input, None::<&IMFAttributes>) }
            .map_err(|error| format!("encoder-set-input-media-type: {error}"))?;
        unsafe { writer.BeginWriting() }
            .map_err(|error| format!("encoder-begin-writing: {error}"))?;
        Ok(Self {
            writer,
            stream,
            width,
            height,
        })
    }

    fn write(&self, bytes: &[u8], pts: i64, duration: i64) -> Result<(), SpikeError> {
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
        unsafe { self.writer.WriteSample(self.stream, &sample)? };
        Ok(())
    }

    fn finalize(self) -> Result<(), SpikeError> {
        unsafe { self.writer.Finalize()? };
        Ok(())
    }
}

fn create_video_type(
    width: u32,
    height: u32,
    frame_rate: u32,
    subtype: windows::core::GUID,
    uncompressed: bool,
) -> Result<IMFMediaType, SpikeError> {
    let media_type = unsafe { MFCreateMediaType()? };
    unsafe {
        media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media_type.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
        media_type.SetUINT64(&MF_MT_FRAME_SIZE, pack_pair(width, height))?;
        media_type.SetUINT64(&MF_MT_FRAME_RATE, pack_pair(frame_rate, 1))?;
        media_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_pair(1, 1))?;
        media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
        media_type.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_0_255.0 as u32)?;
        if uncompressed {
            media_type.SetUINT32(&MF_MT_FIXED_SIZE_SAMPLES, 1)?;
            media_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
            media_type.SetUINT32(&MF_MT_DEFAULT_STRIDE, width)?;
        }
    }
    Ok(media_type)
}

fn create_attributes(count: u32) -> Result<IMFAttributes, SpikeError> {
    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, count)? };
    attributes.ok_or_else(|| "Media Foundation returned no attribute store".into())
}

fn bgra_to_nv12(bgra: &[u8], logical_width: u32, logical_height: u32) -> Vec<u8> {
    let coded_width = even(logical_width);
    let coded_height = even(logical_height);
    let plane_size = usize::try_from(coded_width * coded_height).expect("frame plane fits usize");
    let mut nv12 = vec![0_u8; plane_size * 3 / 2];
    let (luma, chroma) = nv12.split_at_mut(plane_size);
    luma.par_chunks_mut(usize::try_from(coded_width).expect("width fits usize"))
        .enumerate()
        .for_each(|(y, row)| {
            let source_y = u32::try_from(y).unwrap().min(logical_height - 1);
            for (x, destination) in row.iter_mut().enumerate() {
                let source_x = u32::try_from(x).unwrap().min(logical_width - 1);
                let source = bgra_pixel(bgra, logical_width, source_x, source_y);
                *destination = clamp_integer(
                    (54 * i32::from(source[2])
                        + 183 * i32::from(source[1])
                        + 19 * i32::from(source[0])
                        + 128)
                        >> 8,
                );
            }
        });
    chroma
        .par_chunks_mut(usize::try_from(coded_width).expect("width fits usize"))
        .enumerate()
        .for_each(|(row_index, row)| {
            let y = (u32::try_from(row_index).unwrap() * 2).min(logical_height - 1);
            for x in (0..coded_width).step_by(2) {
                let mut red = 0_i32;
                let mut green = 0_i32;
                let mut blue = 0_i32;
                for offset_y in 0..2 {
                    for offset_x in 0..2 {
                        let source = bgra_pixel(
                            bgra,
                            logical_width,
                            (x + offset_x).min(logical_width - 1),
                            (y + offset_y).min(logical_height - 1),
                        );
                        blue += i32::from(source[0]);
                        green += i32::from(source[1]);
                        red += i32::from(source[2]);
                    }
                }
                let offset = usize::try_from(x).unwrap();
                row[offset] =
                    clamp_integer(((-29 * red - 99 * green + 128 * blue + 512) >> 10) + 128);
                row[offset + 1] =
                    clamp_integer(((128 * red - 116 * green - 12 * blue + 512) >> 10) + 128);
            }
        });
    nv12
}

fn bgra_pixel(bytes: &[u8], width: u32, x: u32, y: u32) -> &[u8] {
    let offset = usize::try_from((y * width + x) * 4).expect("pixel offset fits usize");
    &bytes[offset..offset + 4]
}

fn clamp_integer(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

fn even(value: u32) -> u32 {
    value + (value % 2)
}

fn pack_pair(first: u32, second: u32) -> u64 {
    (u64::from(first) << 32) | u64::from(second)
}

fn bitrate(width: u32, height: u32) -> u32 {
    let pixels = u64::from(width) * u64::from(height);
    u32::try_from((pixels * 8).clamp(4_000_000, 50_000_000)).unwrap()
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn media_artifact_path(options: &Options) -> PathBuf {
    let suffix = if matches!(
        options.scenario,
        Scenario::CaptureInterrupt | Scenario::PromotionInterrupt
    ) {
        "staging.mp4"
    } else {
        "mp4"
    };
    options
        .output_dir
        .join(format!("{}.{}", options.run_id, suffix))
}

fn recovery_journal_path(output_dir: &Path, run_id: &str) -> PathBuf {
    output_dir.join(format!("{run_id}.recovery.json"))
}

fn write_recovery_journal(options: &Options, state: &str) -> Result<(), SpikeError> {
    let journal = json!({
        "schemaVersion": 1,
        "applicationBuild": options.build_id,
        "runId": options.run_id,
        "state": state,
        "artifactLabel": format!("artifact:{}-staging-mp4", options.run_id),
        "projectReferenced": false,
        "automaticDeletion": false,
        "networkAccess": false,
    });
    fs::write(
        recovery_journal_path(&options.output_dir, &options.run_id),
        serde_json::to_string_pretty(&journal)?,
    )?;
    Ok(())
}

fn probe_playable(path: &Path) -> Result<bool, SpikeError> {
    let attributes = create_attributes(1)?;
    unsafe { attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)? };
    let wide_path = wide(path);
    let reader = unsafe { MFCreateSourceReaderFromURL(PCWSTR(wide_path.as_ptr()), &attributes)? };
    let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
    unsafe { reader.SetStreamSelection(stream, true)? };
    loop {
        let mut flags = 0_u32;
        let mut sample = None;
        unsafe {
            reader.ReadSample(stream, 0, None, Some(&mut flags), None, Some(&mut sample))?;
        }
        if sample.is_some() {
            return Ok(true);
        }
        if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
            return Ok(false);
        }
    }
}

fn run_recovery_check(options: &Options) -> Result<Value, SpikeError> {
    let input_run_id = options
        .input_run_id
        .as_deref()
        .ok_or("Recovery input run ID is missing")?;
    let journal: Value = serde_json::from_slice(&fs::read(recovery_journal_path(
        &options.output_dir,
        input_run_id,
    ))?)?;
    let state = journal["state"]
        .as_str()
        .ok_or("Recovery journal state is missing")?;
    let media_path = options
        .output_dir
        .join(format!("{input_run_id}.staging.mp4"));
    if !media_path.is_file() {
        return Err("Recovery media is missing".into());
    }
    let playable = probe_playable(&media_path).unwrap_or(false);
    let classification = match state {
        "finalized-unpromoted" if playable => "recoverable-playable-draft",
        "capture-interrupted" | "capture-active" if !playable => "quarantined-unplayable-media",
        "finalized-unpromoted" => return Err("Finalized staging media is not playable".into()),
        "capture-interrupted" | "capture-active" => {
            return Err("Unfinalized staging media unexpectedly passed the playback probe".into())
        }
        _ => return Err("Recovery journal state is unsupported".into()),
    };
    Ok(json!({
        "result": "passed",
        "outcome": "recovery-classified",
        "inputRunId": input_run_id,
        "journalState": state,
        "classification": classification,
        "probePlayable": playable,
        "retainedMedia": true,
        "automaticDeletion": false,
        "projectReferenced": false,
    }))
}

fn run_capture(options: &Options, receiver: Receiver<FrameData>) -> Result<Value, SpikeError> {
    let output_path = match options.scenario {
        Scenario::EncoderFailure => options.output_dir.clone(),
        Scenario::StorageFailure => options
            .output_dir
            .join("intentionally-missing-directory")
            .join(format!("{}.mp4", options.run_id)),
        _ => media_artifact_path(options),
    };
    let report_started = Instant::now();
    let frame_duration = TICKS_PER_SECOND / i64::from(options.frame_rate);
    let deadline = Duration::from_secs(options.duration_seconds);
    let mut writer = None;
    let mut first_source = None;
    let mut last_source = None;
    let mut next_due = 0_i64;
    let mut sampling_skips = 0_u64;
    let mut submitted = 0_u64;
    let mut conversion_ms = 0.0_f64;
    let mut write_sample_ms = 0.0_f64;
    let mut source_width = 0_u32;
    let mut source_height = 0_u32;
    let mut excluded_frames_black = true;
    let mut hud_marker_visible = false;
    while report_started.elapsed() < deadline {
        let frame = match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(frame) => frame,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(error) => return Err(error.into()),
        };
        let first = *first_source.get_or_insert(frame.source_ticks);
        let relative = frame.source_ticks - first;
        if relative < next_due {
            sampling_skips += 1;
            continue;
        }
        next_due += frame_duration;
        while next_due <= relative {
            next_due += frame_duration;
        }
        if options.scenario == Scenario::ProtectedContent {
            excluded_frames_black &= frame
                .bgra
                .chunks_exact(4)
                .all(|pixel| pixel[0] <= 2 && pixel[1] <= 2 && pixel[2] <= 2);
            source_width = frame.width;
            source_height = frame.height;
            last_source = Some(frame.source_ticks);
            submitted += 1;
            continue;
        }
        if options.scenario == Scenario::HudExclusion {
            let marker_pixels = frame
                .bgra
                .chunks_exact(4)
                .filter(|pixel| pixel[0] <= 12 && pixel[1] >= 190 && pixel[2] >= 225)
                .count();
            hud_marker_visible |= marker_pixels >= 1_000;
            source_width = frame.width;
            source_height = frame.height;
            last_source = Some(frame.source_ticks);
            submitted += 1;
            continue;
        }
        if writer.is_none() {
            println!("First capture frame: {}x{}", frame.width, frame.height);
            if options.scenario == Scenario::GpuFailure {
                return Err("Injected GPU readback failure after the first captured frame".into());
            }
            writer = Some(Nv12Writer::create(
                &output_path,
                frame.width,
                frame.height,
                options.frame_rate,
            )?);
            if options.scenario == Scenario::CaptureInterrupt {
                write_recovery_journal(options, "capture-active")?;
            }
            source_width = frame.width;
            source_height = frame.height;
        }
        if frame.width != source_width || frame.height != source_height {
            return Err("Capture source dimensions changed during the run".into());
        }
        let conversion_started = Instant::now();
        let nv12 = bgra_to_nv12(&frame.bgra, frame.width, frame.height);
        conversion_ms += conversion_started.elapsed().as_secs_f64() * 1_000.0;
        let write_started = Instant::now();
        writer
            .as_ref()
            .expect("writer initialized")
            .write(&nv12, relative, frame_duration)?;
        write_sample_ms += write_started.elapsed().as_secs_f64() * 1_000.0;
        last_source = Some(frame.source_ticks);
        submitted += 1;
        if options.scenario == Scenario::DeviceLoss && submitted >= 30 {
            break;
        }
    }
    if options.scenario == Scenario::ProtectedContent {
        let protected_pixels_visible = submitted > 0 && !excluded_frames_black;
        return Ok(json!({
            "result": "passed",
            "outcome": if protected_pixels_visible {
                "direct-window-exclusion-not-enforced"
            } else if submitted == 0 {
                "capture-excluded-no-frames"
            } else {
                "capture-excluded-black-frames"
            },
            "submittedFrames": submitted,
            "sourceWidth": source_width,
            "sourceHeight": source_height,
            "sourceTimestampSpan100ns": last_source.zip(first_source).map(|(last, first)| last - first),
            "displayAffinity": "WDA_EXCLUDEFROMCAPTURE",
            "protectedPixelsVisible": protected_pixels_visible,
            "captureBlocked": !protected_pixels_visible,
            "retainedMedia": false,
        }));
    }
    if options.scenario == Scenario::HudExclusion {
        return Ok(json!({
            "result": "passed",
            "outcome": if hud_marker_visible { "hud-exclusion-fallback-required" } else { "hud-excluded-from-monitor-capture" },
            "submittedFrames": submitted,
            "sourceWidth": source_width,
            "sourceHeight": source_height,
            "sourceTimestampSpan100ns": last_source.zip(first_source).map(|(last, first)| last - first),
            "displayAffinity": "WDA_EXCLUDEFROMCAPTURE",
            "hudMarkerVisible": hud_marker_visible,
            "fallbackRequired": hud_marker_visible,
            "retainedMedia": false,
        }));
    }
    if options.scenario == Scenario::Cancel {
        drop(writer);
        if output_path.exists() {
            fs::remove_file(&output_path)?;
        }
        return Ok(json!({
            "result": "passed",
            "outcome": "cancelled-clean",
            "submittedFrames": submitted,
            "retainedMedia": false,
        }));
    }
    if options.scenario == Scenario::CaptureInterrupt {
        drop(writer);
        write_recovery_journal(options, "capture-interrupted")?;
        return Ok(json!({
            "result": "passed",
            "outcome": "capture-interrupted-retained",
            "classification": "pending-recovery-check",
            "submittedFrames": submitted,
            "outputBytes": fs::metadata(&output_path)?.len(),
            "retainedMedia": true,
            "projectReferenced": false,
            "automaticDeletion": false,
        }));
    }
    let writer = writer.ok_or("No capture frames arrived")?;
    let coded_width = writer.width;
    let coded_height = writer.height;
    if options.scenario == Scenario::FinalizationFailure {
        drop(writer);
        return Err("Injected finalization failure before commit".into());
    }
    let finalize_started = Instant::now();
    writer.finalize()?;
    let finalization_ms = finalize_started.elapsed().as_secs_f64() * 1_000.0;
    if options.scenario == Scenario::PromotionInterrupt {
        write_recovery_journal(options, "finalized-unpromoted")?;
        return Ok(json!({
            "result": "passed",
            "outcome": "promotion-interrupted-retained",
            "classification": "pending-recovery-check",
            "submittedFrames": submitted,
            "finalizationMs": finalization_ms,
            "outputBytes": fs::metadata(&output_path)?.len(),
            "retainedMedia": true,
            "projectReferenced": false,
            "automaticDeletion": false,
        }));
    }
    if options.scenario == Scenario::DecoderFailure {
        return Err("Injected decoder verification failure after finalization".into());
    }
    Ok(json!({
        "result": "passed",
        "outcome": if options.scenario == Scenario::DeviceLoss { "injected-device-loss-finalized-draft" } else { "finalized" },
        "submittedFrames": submitted,
        "sourceWidth": source_width,
        "sourceHeight": source_height,
        "codedWidth": coded_width,
        "codedHeight": coded_height,
        "sourceTimestampSpan100ns": last_source.zip(first_source).map(|(last, first)| last - first),
        "conversionMs": conversion_ms,
        "writeSampleMs": write_sample_ms,
        "samplingSkippedFrames": sampling_skips,
        "finalizationMs": finalization_ms,
        "outputBytes": fs::metadata(&output_path)?.len(),
        "retainedMedia": true,
        "projectReferenced": false,
        "deviceLossInjection": options.scenario == Scenario::DeviceLoss,
    }))
}

fn main() -> Result<(), SpikeError> {
    let args: Vec<String> = env::args().collect();
    if args.get(1).is_some_and(|value| value == "--fixture-host") {
        return run_fixture_host(
            args.get(2)
                .is_some_and(|value| value == "--exclude-from-capture"),
        );
    }
    let options = Options::parse(&args)?;
    fs::create_dir_all(&options.output_dir)?;
    let mut fixture = if matches!(
        options.target,
        Target::ControlledFixtureWindow | Target::FixtureMonitor
    ) && options.scenario != Scenario::RecoveryCheck
    {
        Some(FixtureProcess::spawn(matches!(
            options.scenario,
            Scenario::ProtectedContent | Scenario::HudExclusion
        ))?)
    } else {
        None
    };
    if options.scenario == Scenario::SourceClose {
        fixture
            .as_mut()
            .ok_or("Source-close requires the controlled fixture target")?
            .close_after(Duration::from_secs(1))?;
    }
    if options.scenario == Scenario::HudExclusion && options.target != Target::FixtureMonitor {
        return Err("HUD exclusion requires the fixture-monitor target".into());
    }
    if options.countdown_seconds > 0 && options.scenario != Scenario::RecoveryCheck {
        println!("Capture begins in {} seconds", options.countdown_seconds);
        std::thread::sleep(Duration::from_secs(options.countdown_seconds));
    }
    let _com = ComGuard::initialize()?;
    let _media_foundation = MediaFoundationGuard::initialize()?;
    let started_at = format!("unix-ms-{}", unix_millis());
    let report_path = options.output_dir.join(format!("{}.json", options.run_id));
    let mut result = (|| -> Result<Value, SpikeError> {
        if options.scenario == Scenario::RecoveryCheck {
            return run_recovery_check(&options);
        }
        if options.scenario == Scenario::InitializationFailure {
            return Err("Injected native stack initialization failure".into());
        }
        let devices = create_d3d_devices()?;
        let item = capture_item(options.target)?;
        let (sender, receiver) = mpsc::sync_channel(2);
        let callback_error = Arc::new(Mutex::new(None));
        let dropped = Arc::new(AtomicU64::new(0));
        let capture = CaptureSession::start(
            &devices,
            item,
            sender,
            callback_error.clone(),
            dropped.clone(),
        )?;
        let mut report = run_capture(&options, receiver)?;
        let source_closed = capture.source_closed();
        let source_process_exited = fixture.as_ref().is_some_and(FixtureProcess::has_exited);
        drop(capture);
        if let Some(error) = callback_error
            .lock()
            .expect("capture error mutex poisoned")
            .take()
        {
            return Err(error.into());
        }
        report["callbackDroppedFrames"] = json!(dropped.load(Ordering::Relaxed));
        report["sourceClosed"] = json!(source_closed);
        if options.scenario == Scenario::SourceClose {
            if !source_process_exited {
                return Err("The controlled source process did not exit during capture".into());
            }
            report["outcome"] = json!("source-closed-finalized-draft");
            report["sourceCloseDetection"] = json!(if source_closed {
                "graphics-capture-closed-event"
            } else {
                "owned-source-exit-fallback"
            });
        }
        Ok(report)
    })();
    let media_path = media_artifact_path(&options);
    let mut failure_cleanup = None;
    if result.is_err() && media_path.exists() {
        if let Err(error) = fs::remove_file(&media_path) {
            failure_cleanup = Some(error.to_string());
            result =
                Err(format!("Failure cleanup could not remove the partial media: {error}").into());
        }
    }
    let report = match result {
        Ok(mut report) => {
            report["schemaVersion"] = json!(1);
            report["applicationBuild"] = json!(options.build_id);
            report["runId"] = json!(options.run_id);
            report["scenario"] = json!(options.scenario.label());
            report["target"] = json!(options.target.label());
            report["startedAt"] = json!(started_at);
            report["networkAccess"] = json!(false);
            report["projectWrites"] = json!(false);
            report["audioCapture"] = json!(false);
            report["microphoneCapture"] = json!(false);
            report["failureCleanup"] = json!("not-applicable");
            report
        }
        Err(error) => json!({
            "schemaVersion": 1,
            "applicationBuild": options.build_id,
            "runId": options.run_id,
            "scenario": options.scenario.label(),
            "target": options.target.label(),
            "startedAt": started_at,
            "result": if options.scenario.expected_failure_outcome().is_some() { "passed" } else { "failed" },
            "outcome": options.scenario.expected_failure_outcome().unwrap_or("failed"),
            "errorMessage": error.to_string(),
            "retainedMedia": media_path.exists(),
            "failureCleanup": if failure_cleanup.is_some() { "failed" } else { "passed" },
            "cleanupError": failure_cleanup,
            "networkAccess": false,
            "projectWrites": false,
            "audioCapture": false,
            "microphoneCapture": false,
        }),
    };
    fs::write(&report_path, serde_json::to_string_pretty(&report)?)?;
    println!("Report: {}", report_path.display());
    if report["result"] != "passed" {
        return Err(report["errorMessage"]
            .as_str()
            .unwrap_or("Direct capture stack spike failed")
            .to_string()
            .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        std::iter::once("spike".to_string())
            .chain(values.iter().map(|value| value.to_string()))
            .collect()
    }

    #[test]
    fn parses_controlled_capture_options() {
        let options = Options::parse(&args(&[
            "--build-id",
            "58c113c",
            "--run-id",
            "capture-01",
            "--target",
            "controlled-fixture-window",
            "--duration",
            "30",
        ]))
        .unwrap();
        assert_eq!(options.target, Target::ControlledFixtureWindow);
        assert_eq!(options.duration_seconds, 30);
    }

    #[test]
    fn rejects_unsafe_run_id() {
        assert!(
            Options::parse(&args(&["--build-id", "58c113c", "--run-id", "../escape",])).is_err()
        );
    }

    #[test]
    fn pads_odd_bgra_to_even_nv12_with_replicated_edges() {
        let pixels = vec![0_u8, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255];
        let converted = bgra_to_nv12(&pixels, 3, 1);
        assert_eq!(converted.len(), 12);
        assert_eq!(converted[2], converted[3]);
    }

    #[test]
    fn frame_duration_uses_media_foundation_integer_ticks() {
        assert_eq!(TICKS_PER_SECOND / 30, 333_333);
        assert_eq!(TICKS_PER_SECOND / 60, 166_666);
    }

    #[test]
    fn fixed_point_rec709_stays_within_one_channel_value() {
        for [red, green, blue] in [
            [0_u8, 0, 0],
            [255, 255, 255],
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [27, 149, 211],
        ] {
            let bgra = [blue, green, red, 255];
            let converted = bgra_to_nv12(&bgra, 1, 1);
            let expected = [
                (0.2126 * f32::from(red) + 0.7152 * f32::from(green) + 0.0722 * f32::from(blue))
                    .round() as i32,
                (128.0 - 0.114_572 * f32::from(red) - 0.385_428 * f32::from(green)
                    + 0.5 * f32::from(blue))
                .round() as i32,
                (128.0 + 0.5 * f32::from(red)
                    - 0.454_153 * f32::from(green)
                    - 0.045_847 * f32::from(blue))
                .round() as i32,
            ];
            let actual = [
                i32::from(converted[0]),
                i32::from(converted[4]),
                i32::from(converted[5]),
            ];
            assert!(actual
                .iter()
                .zip(expected)
                .all(|(actual, expected)| (actual - expected).abs() <= 1));
        }
    }
}
