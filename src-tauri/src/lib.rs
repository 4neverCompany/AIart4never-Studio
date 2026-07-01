use std::fs::{File, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// Holds the running Node sidecar child so we can kill it on app quit.
struct SidecarState(Mutex<Option<Child>>);

/// Kill the Node sidecar process (if any). Used by both the tray's "Quit"
/// menu item and any future explicit-shutdown path. Idempotent — safe to
/// call when no sidecar exists or the mutex is poisoned.
///
/// FEAT-TRAY-AUTOSTART (2026-05-20): extracted out of the previous
/// CloseRequested handler. With tray-hide behavior, closing the window
/// no longer ends the app, so the kill path needed its own entry point.
fn kill_sidecar(app: &AppHandle, reason: &str) {
    let log_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("logs"));
    let log_to_startup = |line: &str| {
        if let Some(ref ld) = log_dir {
            startup_log_line(ld, line);
        }
    };

    let Some(state) = app.try_state::<SidecarState>() else {
        log_to_startup(&format!(
            "{}: SidecarState not registered (skipping kill)",
            reason
        ));
        return;
    };
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(e) => {
            log_to_startup(&format!(
                "{}: SidecarState mutex poisoned ({}) — sidecar may leak",
                reason, e
            ));
            return;
        }
    };
    let Some(mut child) = guard.take() else {
        log_to_startup(&format!(
            "{}: no sidecar Child to kill (already taken or never spawned)",
            reason
        ));
        return;
    };
    let pid = child.id();
    log::info!("[tauri] {}: killing sidecar pid={}", reason, pid);
    log_to_startup(&format!("{}: killing sidecar pid={}", reason, pid));
    let kill_result = child.kill();
    let wait_result = child.wait();
    log_to_startup(&format!(
        "{} pid={} kill={} wait={}",
        reason,
        pid,
        if kill_result.is_ok() { "ok" } else { "err" },
        wait_result
            .as_ref()
            .map(|s| s.to_string())
            .unwrap_or_else(|e| format!("err: {}", e)),
    ));
}

/// Stable loopback port for the Next.js sidecar.
///
/// STORY-121: the webview persists settings via IndexedDB, which is
/// origin-scoped (`host:port`). Previously we picked an ephemeral port
/// on every launch, so each run produced a new origin
/// (`http://127.0.0.1:<random>`) and the IndexedDB lookup missed the
/// previous session's data — settings, carousel groups, pipeline
/// state, API keys all appeared wiped. WebView2 was faithfully
/// persisting everything, just under the prior launch's origin key.
///
/// Fixing the port pins the origin across launches. 19782 is IANA-
/// unassigned, outside both the Windows (49152–65535) and Linux
/// (32768–60999) ephemeral ranges, and well above the privileged-
/// port cutoff so no elevation is needed.
const DESKTOP_PORT: u16 = 19782;

/// Resolve the port to bind the sidecar on.
///
/// First tries the stable `DESKTOP_PORT` (IndexedDB persistence). If
/// something else is already bound there, falls back to an ephemeral
/// port so the app still launches — but logs a prominent warning that
/// settings persistence is broken for this session, which is the one
/// regression we'd otherwise hit silently.
fn resolve_port(log_dir: &Path) -> Option<u16> {
    match TcpListener::bind(("127.0.0.1", DESKTOP_PORT)) {
        Ok(listener) => {
            let port = listener.local_addr().ok()?.port();
            startup_log_line(log_dir, &format!("bound stable port {}", port));
            Some(port)
        }
        Err(e) => {
            startup_log_line(
                log_dir,
                &format!(
                    "WARN stable port {} unavailable ({}) — falling back to ephemeral. \
                     Settings WILL NOT persist across launches until the conflicting \
                     process is closed.",
                    DESKTOP_PORT, e
                ),
            );
            let listener = TcpListener::bind("127.0.0.1:0").ok()?;
            let addr = listener.local_addr().ok()?;
            startup_log_line(log_dir, &format!("bound ephemeral port {}", addr.port()));
            Some(addr.port())
        }
    }
}

/// Poll the loopback port until it accepts a TCP connection, up to `timeout`.
fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    let target = format!("127.0.0.1:{}", port);
    while start.elapsed() < timeout {
        if let Ok(addr) = target.parse::<std::net::SocketAddr>() {
            if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
                return true;
            }
        }
        thread::sleep(Duration::from_millis(150));
    }
    false
}

/// Resolve a named subdirectory inside the Tauri resources dir.
///
/// STORY-110 resolved the long-standing question about how Tauri v2
/// places globbed resources. Inspection of the signed MSI (msiinfo
/// export File/Directory tables against commit 5edb4e0) confirmed
/// that `"resources/**/*"` in array-form produces the NESTED layout:
/// files land at `<resource_dir>/resources/<name>/...`, preserving
/// the full relative path via `resource_relpath()` in
/// tauri-utils-2.8.3/src/resources.rs:216-219. The flat layout
/// (prefix stripped) only occurs with the map form + glob key, which
/// we intentionally do not use because it breaks local `cargo check`
/// on WSL where the gitignored staging dirs are empty.
///
/// We nevertheless keep the flat-layout probe as insurance: a future
/// Tauri upgrade could change the default, and the cost of the extra
/// `exists()` call is ~1µs on Windows. If this ever fires in
/// production, `log_dir_tree` will have already written the real
/// layout to `startup.log` so we can re-verify in seconds.
fn find_resource_subdir(resource_dir: &Path, name: &str) -> Option<PathBuf> {
    let flat = resource_dir.join(name);
    if flat.exists() {
        return Some(flat);
    }
    let nested = resource_dir.join("resources").join(name);
    if nested.exists() {
        return Some(nested);
    }
    None
}

/// Resolve the bundled Node.js binary inside the Tauri resources dir.
/// Build scripts place the Windows `node.exe` at `resources/node/node.exe`
/// and a Unix `node` (used only for Linux validation builds from WSL)
/// at `resources/node/bin/node`. `node_root` is the directory returned by
/// `find_resource_subdir(&resource_dir, "node")`.
fn node_binary_path(node_root: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        node_root.join("node.exe")
    } else {
        node_root.join("bin").join("node")
    }
}

/// Walk `dir` up to `max_depth` levels and append every entry to
/// startup.log. Used on the first boot after a fresh install so we
/// have an authoritative record of the on-disk resource layout
/// regardless of how Tauri v2 decides to place globbed files.
fn log_dir_tree(log_dir: &Path, root: &Path, label: &str, max_depth: usize) {
    startup_log_line(log_dir, &format!("---- {} tree ({}) ----", label, root.display()));
    fn walk(log_dir: &Path, dir: &Path, depth: usize, max_depth: usize) {
        if depth > max_depth {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) => {
                startup_log_line(log_dir, &format!("  read_dir({}) failed: {}", dir.display(), e));
                return;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let indent = "  ".repeat(depth + 1);
            let kind = if path.is_dir() { "dir " } else { "file" };
            startup_log_line(log_dir, &format!("{}{} {}", indent, kind, path.display()));
            if path.is_dir() {
                walk(log_dir, &path, depth + 1, max_depth);
            }
        }
    }
    walk(log_dir, root, 0, max_depth);
    startup_log_line(log_dir, "---- end tree ----");
}

/// Resolve the per-user log directory. Returns the app_data_dir joined with
/// "logs". Falls back to a tempdir if app_data_dir itself is unavailable,
/// because we'd rather write logs *somewhere* than panic our panic handler.
fn resolve_log_dir(app_data_dir: Option<PathBuf>) -> PathBuf {
    let base = app_data_dir.unwrap_or_else(std::env::temp_dir);
    base.join("logs")
}

/// Append a line to startup.log. Ignores I/O errors — the diagnostic log
/// must never be the thing that takes down the app.
fn startup_log_line(log_dir: &Path, line: &str) {
    let _ = std::fs::create_dir_all(log_dir);
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("startup.log"))
    {
        let ts = chrono_like_timestamp();
        let _ = writeln!(f, "[{}] {}", ts, line);
    }
}

/// Tiny timestamp helper so we don't pull in `chrono` for one format call.
/// Format: seconds-since-epoch. Good enough for correlating log lines.
fn chrono_like_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => format!("{}", d.as_secs()),
        Err(_) => "?".to_string(),
    }
}

/// Prune old crash logs — keep the N most-recent files, delete the rest.
/// Called once on startup so crash dirs don't grow unbounded.
fn prune_crash_logs(crash_dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(crash_dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let meta = std::fs::metadata(&p).ok()?;
            if meta.is_file() { Some((meta.modified().unwrap_or(std::time::UNIX_EPOCH), p)) } else { None }
        })
        .collect();
    if files.len() <= keep { return }
    files.sort_by_key(|(t, _)| *t);
    for (_, path) in files.iter().take(files.len() - keep) {
        let _ = std::fs::remove_file(path);
    }
}

/// Install a panic hook that writes the panic payload to startup.log AND a
/// dedicated crash file so Release builds leave a breadcrumb on crash.
/// `crash_dir` is `<log_dir>/crashes/`.
fn install_panic_hook(log_dir: PathBuf) {
    let crash_dir = log_dir.join("crashes");
    let _ = std::fs::create_dir_all(&crash_dir);
    prune_crash_logs(&crash_dir, 50);

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic payload".to_string()
        };
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown location".to_string());

        // Write to startup.log (existing behaviour)
        startup_log_line(&log_dir, &format!("PANIC at {}: {}", loc, payload));

        // Write a dedicated timestamped crash file
        let ts = chrono_like_timestamp();
        let crash_path = crash_dir.join(format!("crash-{}.log", ts));
        if let Ok(mut f) = std::fs::File::create(&crash_path) {
            let bt = std::backtrace::Backtrace::force_capture();
            let _ = writeln!(f, "MashupForge crash report");
            let _ = writeln!(f, "version: {}", env!("CARGO_PKG_VERSION"));
            let _ = writeln!(f, "os: {} {}", std::env::consts::OS, std::env::consts::ARCH);
            let _ = writeln!(f, "timestamp: {}", ts);
            let _ = writeln!(f, "location: {}", loc);
            let _ = writeln!(f, "panic: {}", payload);
            let _ = writeln!(f, "---backtrace---\n{}", bt);
        }

        default_hook(info);
    }));
}

/// Show a Windows native MessageBox via user32.MessageBoxW.
/// No-op on non-Windows. Uses direct FFI so we avoid pulling a dialog
/// crate just for a startup error popup.
#[cfg(target_os = "windows")]
fn show_error_dialog(title: &str, body: &str) {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            utype: u32,
        ) -> i32;
    }
    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;

    let to_wide = |s: &str| -> Vec<u16> { OsStr::new(s).encode_wide().chain(once(0)).collect() };
    let wtitle = to_wide(title);
    let wbody = to_wide(body);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            wbody.as_ptr(),
            wtitle.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn show_error_dialog(_title: &str, _body: &str) {
    // No-op on non-Windows hosts — Linux validation builds don't need it.
}

/// Attach the spawned sidecar process to a Windows Job Object with
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the kernel guarantees the
/// child dies when this parent process dies — by ANY mechanism.
///
/// BUG-003: the WindowEvent::CloseRequested handler at the bottom of
/// `run()` correctly kills the sidecar when the user clicks the X
/// button — but Tauri's `restart()` (called from the JS
/// `tauri-plugin-process` `relaunch()` API after auto-update, see
/// BUG-002) uses `std::process::exit(0)` internally, which fires
/// ZERO Tauri events. Neither WindowEvent::CloseRequested nor
/// RunEvent::ExitRequested runs on that path, so node.exe orphans
/// and keeps holding DESKTOP_PORT (19782).
///
/// Job Objects are the OS-level fix: as long as we don't explicitly
/// CloseHandle the job, the parent-process handle table holds it
/// open. When the parent dies — via `exit()`, panic, Task Manager
/// kill, or any other path — the kernel automatically closes its
/// handles, the job's last reference drops, and KILL_ON_JOB_CLOSE
/// forcibly terminates every process in the job.
///
/// Requires Windows 8+ for nested job support (we already ship
/// Windows 10+). On non-Windows targets this is a no-op.
#[cfg(target_os = "windows")]
fn attach_sidecar_to_kill_on_close_job(child_pid: u32) -> Result<(), String> {
    use std::os::raw::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(lp_job_attributes: *mut c_void, lp_name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            h_job: *mut c_void,
            job_object_info_class: i32,
            lp_job_object_information: *mut c_void,
            cb_job_object_information_length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(h_job: *mut c_void, h_process: *mut c_void) -> i32;
        fn OpenProcess(
            dw_desired_access: u32,
            b_inherit_handle: i32,
            dw_process_id: u32,
        ) -> *mut c_void;
        fn CloseHandle(h_object: *mut c_void) -> i32;
    }

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const PROCESS_TERMINATE: u32 = 0x0001;

    #[repr(C)]
    #[derive(Default)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct JobObjectExtendedLimitInformationStruct {
        basic_limit_info: JobObjectBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return Err("CreateJobObjectW returned NULL".into());
        }

        let mut info = JobObjectExtendedLimitInformationStruct::default();
        info.basic_limit_info.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        if SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<JobObjectExtendedLimitInformationStruct>() as u32,
        ) == 0
        {
            CloseHandle(job);
            return Err("SetInformationJobObject failed".into());
        }

        let proc_handle = OpenProcess(
            PROCESS_SET_QUOTA | PROCESS_TERMINATE,
            0,
            child_pid,
        );
        if proc_handle.is_null() {
            CloseHandle(job);
            return Err(format!("OpenProcess({}) returned NULL", child_pid));
        }

        if AssignProcessToJobObject(job, proc_handle) == 0 {
            CloseHandle(proc_handle);
            CloseHandle(job);
            return Err("AssignProcessToJobObject failed".into());
        }

        // Drop the per-process handle (the job retains its own kernel
        // reference to the process). Intentionally DO NOT CloseHandle
        // the job — leaving the parent's handle open is what keeps the
        // job alive. When the parent dies, the kernel cleans up its
        // handle table, the job's last ref drops, and
        // KILL_ON_JOB_CLOSE forcibly terminates the sidecar.
        CloseHandle(proc_handle);
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn attach_sidecar_to_kill_on_close_job(_child_pid: u32) -> Result<(), String> {
    // Unix exit semantics already SIGTERM child processes when the parent
    // exits cleanly; the Linux/macOS validation builds don't need a
    // separate kernel-level kill-on-close mechanism. The CloseRequested
    // handler covers the clean-shutdown case on those platforms.
    Ok(())
}

/// Validate that every resource the sidecar needs is present on disk.
/// Returns a human-readable error with the first missing path.
fn preflight_resources(
    resource_dir: &Path,
    node_bin: &Path,
    start_js: &Path,
) -> Result<(), String> {
    if !resource_dir.exists() {
        return Err(format!(
            "resource_dir missing at {} — the installer may be corrupted",
            resource_dir.display()
        ));
    }
    if !node_bin.exists() {
        return Err(format!(
            "bundled Node.js missing at {} — rerun build-windows.ps1 step [3/7] (fetch-windows-node.ps1)",
            node_bin.display()
        ));
    }
    if !start_js.exists() {
        return Err(format!(
            "Node sidecar entry missing at {} — rerun build-windows.ps1 step [6/7] (copy-standalone-to-resources.ps1)",
            start_js.display()
        ));
    }
    let server_js = start_js.with_file_name("server.js");
    if !server_js.exists() {
        return Err(format!(
            "Next standalone server missing at {} — .next/standalone was not copied correctly",
            server_js.display()
        ));
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SidecarState(Mutex::new(None)))
        // tauri-plugin-log runs in BOTH debug and release so the installed
        // .msi leaves a diagnostic trail under
        // %APPDATA%\MashupForge\logs\. Previously this plugin was
        // debug-only, which meant Release crashes were completely silent
        // (no console thanks to `windows_subsystem = "windows"`, no log
        // file, no error dialog) — see STORY-080.
        // STORY-122 followup: opener plugin lets the update toast open the
        // GitHub release URL in the user's default browser instead of
        // asking them to copy-paste a text input. No capability churn
        // beyond the default permission set (see capabilities/default.json).
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        // BUG-002: tauri_plugin_process exposes the JS `relaunch()` API.
        // Frontend calls it after `update.downloadAndInstall(...)` so the
        // OLD app exits cleanly — firing WindowEvent::CloseRequested
        // below, which kills the Node sidecar and frees DESKTOP_PORT
        // (19782). Without this the NSIS installer's `/R` flag spawns
        // the new app while the old one still holds the stable port,
        // forcing the new instance onto an ephemeral port and breaking
        // the IndexedDB origin pin (STORY-121). See lib.rs:622+ for
        // the sidecar-kill handler this triggers.
        .plugin(tauri_plugin_process::init())
        // V1.4.5: tauri-plugin-fs backs the JS @tauri-apps/plugin-fs
        // calls in lib/images/storage.ts (file-per-image persistence)
        // and lib/backup/images.ts (auto-backup + salt backup). The
        // v1.4.4 mega-release shipped the JS side without registering
        // the Rust plugin, so every call rejected inside its
        // try/catch — persist/export/restore silently did nothing.
        // Scopes live in capabilities/default.json ($APPDATA, the
        // Documents backup folder, and the config.json salt path).
        .plugin(tauri_plugin_fs::init())
        // V1.1.2-SINGLE-INSTANCE: tauri-plugin-single-instance routes
        // a second launch (e.g. an OS-handled `mashupforge://oauth/callback`
        // click) to the running instance instead of spawning a fresh
        // Tauri process. Without this, the OAuth callback opens a new
        // WebView2 with no state/PKCE cookies and the user lands on
        // the empty "Welcome Back" login screen with a `expired_flow`
        // error. The `deep-link` feature routes the second-launch args
        // (which contain the deep-link URL) into the existing
        // on_open_url handler, so the existing deep-link listener in
        // HiggsfieldConnection.tsx picks it up unchanged.
        //
        // MUST be registered BEFORE tauri-plugin-deep-link so the
        // single-instance init can wrap the second-launch routing
        // before the deep-link plugin's own URL handling kicks in.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Bring the main window forward. unminimize() in case the
            // user minimized the running instance before the OAuth
            // round-trip; set_focus() to surface it on top of other
            // apps.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // The single-instance plugin's `deep-link` feature
            // already extracts the `mashupforge://` URLs from the
            // launch args and emits them as a "deep-link" event on
            // the AppHandle (same channel the regular on_open_url
            // handler uses), so the existing frontend listener in
            // HiggsfieldConnection.tsx picks them up and re-issues
            // the callback in the WebView2 cookie context.
            //
            // No manual emit here — the plugin does it for us.
            log::info!("[tauri] single-instance fired with {} args, deep-link URLs handled by plugin", args.len());
        }))
        // V107.1-OAUTH: tauri-plugin-deep-link registers the
        // `mashupforge://` URL scheme with the OS. When the Higgsfield
        // OAuth provider redirects to `mashupforge://oauth/callback?code=...&state=...`
        // the OS launches (or focuses) the Tauri app and the plugin
        // emits a "deep-link://new-url" event with the URL. The frontend
        // listener (components/Settings/HiggsfieldConnection.tsx) re-issues
        // the callback fetch in the WebView2 cookie context, which avoids
        // the `expired_flow` error caused by cookies set in WebView2 not
        // surviving a redirect to the system browser.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("tauri".to_string()),
                    }),
                ])
                .build(),
        )
        .setup(|app| {
            // ---- step 0: set up observability FIRST so every subsequent
            // error gets logged. `app.path().app_data_dir()` is the same
            // folder tauri-plugin-log writes tauri.log into, which means
            // the panic hook and plugin agree on one output location.
            let app_data_dir = app.path().app_data_dir().ok();
            let log_dir = resolve_log_dir(app_data_dir.clone());
            let _ = std::fs::create_dir_all(&log_dir);
            install_panic_hook(log_dir.clone());

            startup_log_line(&log_dir, "=== MashupForge launcher starting ===");
            startup_log_line(
                &log_dir,
                &format!("build_mode={}", if cfg!(debug_assertions) { "debug" } else { "release" }),
            );

            // ---- step 1: resolve paths
            let resource_dir = match app.path().resource_dir() {
                Ok(d) => d,
                Err(e) => {
                    let msg = format!("resource_dir() failed: {}", e);
                    startup_log_line(&log_dir, &msg);
                    show_error_dialog(
                        "MashupForge — startup error",
                        &format!(
                            "Could not locate the app resources directory.\n\n{}\n\nLog: {}",
                            msg,
                            log_dir.display()
                        ),
                    );
                    return Err(e.into());
                }
            };
            startup_log_line(&log_dir, &format!("resource_dir = {}", resource_dir.display()));
            startup_log_line(&log_dir, &format!("log_dir      = {}", log_dir.display()));

            // Dump the full resource_dir tree on every launch so we have
            // an authoritative record of what the installer actually
            // shipped. Cheap (<1ms for a few hundred entries) and
            // priceless after a crash.
            log_dir_tree(&log_dir, &resource_dir, "resource_dir", 2);

            // Tauri v2 globbing may or may not strip the `resources/`
            // segment from `"resources/**/*"`. Probe both layouts.
            let node_root = match find_resource_subdir(&resource_dir, "node") {
                Some(p) => {
                    startup_log_line(&log_dir, &format!("node_root    = {}", p.display()));
                    p
                }
                None => {
                    let msg = format!(
                        "bundled Node.js dir not found under {} (checked /node and /resources/node) — installer is missing resources, rerun build-windows.ps1",
                        resource_dir.display()
                    );
                    startup_log_line(&log_dir, &format!("PREFLIGHT FAIL: {}", msg));
                    show_error_dialog(
                        "MashupForge — missing resource",
                        &format!(
                            "{}\n\nFull log: {}",
                            msg,
                            log_dir.join("startup.log").display()
                        ),
                    );
                    return Err(msg.into());
                }
            };
            let app_dir = match find_resource_subdir(&resource_dir, "app") {
                Some(p) => {
                    startup_log_line(&log_dir, &format!("app_dir      = {}", p.display()));
                    p
                }
                None => {
                    let msg = format!(
                        "Next standalone app dir not found under {} (checked /app and /resources/app) — installer is missing resources, rerun build-windows.ps1",
                        resource_dir.display()
                    );
                    startup_log_line(&log_dir, &format!("PREFLIGHT FAIL: {}", msg));
                    show_error_dialog(
                        "MashupForge — missing resource",
                        &format!(
                            "{}\n\nFull log: {}",
                            msg,
                            log_dir.join("startup.log").display()
                        ),
                    );
                    return Err(msg.into());
                }
            };
            let node_bin = node_binary_path(&node_root);
            let start_js = app_dir.join("start.js");

            startup_log_line(&log_dir, &format!("node_bin     = {}", node_bin.display()));
            startup_log_line(&log_dir, &format!("start_js     = {}", start_js.display()));

            // ---- step 2: pre-flight existence checks
            if let Err(msg) = preflight_resources(&resource_dir, &node_bin, &start_js) {
                startup_log_line(&log_dir, &format!("PREFLIGHT FAIL: {}", msg));
                show_error_dialog(
                    "MashupForge — missing resource",
                    &format!(
                        "The installer is missing a required file:\n\n{}\n\nFull log: {}",
                        msg,
                        log_dir.join("startup.log").display()
                    ),
                );
                return Err(msg.into());
            }

            // ---- step 3: pi.dev runtime install dir (user-writable) — M3.3-P3 commit c: gone with the pi deletion.
            // ---- step 4: resolve loopback port (stable for IndexedDB
            // persistence, ephemeral fallback if the stable port is
            // already in use — see STORY-121).
            let port = match resolve_port(&log_dir) {
                Some(p) => p,
                None => {
                    let msg = "could not bind any 127.0.0.1 port";
                    startup_log_line(&log_dir, msg);
                    show_error_dialog(
                        "MashupForge — networking error",
                        &format!(
                            "Could not acquire a free local port on 127.0.0.1.\n\nLog: {}",
                            log_dir.join("startup.log").display()
                        ),
                    );
                    return Err(msg.into());
                }
            };
            startup_log_line(&log_dir, &format!("picked port {}", port));

            // ---- step 5: spawn sidecar with stdout/stderr piped to a log file
            //
            // In Release builds `windows_subsystem = "windows"` hides the
            // console, so `Stdio::inherit()` silently drops every console.log
            // the sidecar emits. We redirect both streams to sidecar.log
            // under the same log_dir so Maurice can grep it after a crash.
            let sidecar_log_path = log_dir.join("sidecar.log");
            let sidecar_log_file = match File::create(&sidecar_log_path) {
                Ok(f) => f,
                Err(e) => {
                    let msg = format!(
                        "could not create {}: {}",
                        sidecar_log_path.display(),
                        e
                    );
                    startup_log_line(&log_dir, &msg);
                    show_error_dialog("MashupForge — startup error", &msg);
                    return Err(msg.into());
                }
            };
            let sidecar_log_file_err = sidecar_log_file.try_clone().map_err(|e| {
                let m = format!("clone sidecar log handle: {}", e);
                startup_log_line(&log_dir, &m);
                m
            })?;

            let mut cmd = Command::new(&node_bin);
            cmd.arg(&start_js)
                .current_dir(&app_dir)
                .env("PORT", port.to_string())
                .env("HOSTNAME", "127.0.0.1")
                .env("HOST", "127.0.0.1")
                .env("NODE_ENV", "production")
                .env("MASHUPFORGE_RESOURCES_DIR", &resource_dir)
                .env("MASHUPFORGE_LOG_DIR", &log_dir)
                .env("MASHUPFORGE_CRASH_DIR", log_dir.join("crashes"))
                .env("MASHUPFORGE_DESKTOP", "1")
                .stdout(Stdio::from(sidecar_log_file))
                .stderr(Stdio::from(sidecar_log_file_err));

            // V1.6: bundled Higgsfield CLI (Windows). When the installer ships
            // resources/higgsfield-cli (staged by scripts/install-higgsfield-cli.ps1
            // -Dest src-tauri/resources/higgsfield-cli -NoEnv), point the provider
            // adapter at it via HIGGSFIELD_BIN — UNLESS the user already set
            // HIGGSFIELD_BIN themselves (an explicit per-user install wins). The
            // npm .cmd shim resolves `node` via PATH, so we also prepend the
            // bundled Node dir so the shim finds OUR Node runtime instead of
            // relying on a system Node being present.
            #[cfg(target_os = "windows")]
            {
                if std::env::var_os("HIGGSFIELD_BIN").is_none() {
                    if let Some(hf_root) = find_resource_subdir(&resource_dir, "higgsfield-cli") {
                        let shim = hf_root
                            .join("node_modules")
                            .join(".bin")
                            .join("higgsfield.cmd");
                        if shim.exists() {
                            cmd.env("HIGGSFIELD_BIN", &shim);
                            startup_log_line(
                                &log_dir,
                                &format!("bundled higgsfield CLI -> {}", shim.display()),
                            );
                        } else {
                            startup_log_line(
                                &log_dir,
                                &format!("higgsfield-cli resource present but shim missing at {}", shim.display()),
                            );
                        }
                    }
                }
                if let Some(node_dir) = node_bin.parent() {
                    let prev = std::env::var("PATH").unwrap_or_default();
                    cmd.env("PATH", format!("{};{}", node_dir.display(), prev));
                }
            }

            // Suppress the flashing console window on Windows release spawn.
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }

            let child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    let msg = format!(
                        "failed to spawn node sidecar at {}: {}",
                        node_bin.display(),
                        e
                    );
                    startup_log_line(&log_dir, &msg);
                    show_error_dialog(
                        "MashupForge — sidecar failed to start",
                        &format!(
                            "{}\n\nCheck {} for details.",
                            msg,
                            log_dir.join("startup.log").display()
                        ),
                    );
                    return Err(msg.into());
                }
            };

            startup_log_line(&log_dir, &format!("spawned sidecar pid={}", child.id()));

            // BUG-003: attach sidecar to a Windows Job Object with
            // KILL_ON_JOB_CLOSE so node.exe dies when this parent dies,
            // even on exit paths that bypass WindowEvent::CloseRequested
            // (notably tauri::App::restart() used by the auto-updater
            // relaunch flow — see the helper's docstring). On non-Windows
            // this is a no-op. Failures are logged but non-fatal: the
            // CloseRequested handler still covers clean shutdowns.
            let sidecar_pid = child.id();
            match attach_sidecar_to_kill_on_close_job(sidecar_pid) {
                Ok(()) => startup_log_line(
                    &log_dir,
                    &format!(
                        "attached sidecar pid={} to KILL_ON_JOB_CLOSE Job",
                        sidecar_pid
                    ),
                ),
                Err(e) => startup_log_line(
                    &log_dir,
                    &format!(
                        "WARN attach_sidecar_to_kill_on_close_job(pid={}) failed: {} \
                         — sidecar may leak on abnormal parent exit (Task Manager / \
                         updater relaunch). CloseRequested handler still covers the \
                         X-button close path.",
                        sidecar_pid, e
                    ),
                ),
            }

            app.state::<SidecarState>()
                .0
                .lock()
                .expect("sidecar state poisoned")
                .replace(child);

            // ---- step 6: wait for the server on a background thread,
            // then navigate the main window. While we wait, the window
            // keeps showing the frontend-stub loading screen.
            //
            // Timeout bumped from 30s to 60s: on freshly installed Program
            // Files builds, Windows Defender scans every .js on first
            // require(), and Next.js standalone boot on a cold filesystem
            // routinely crosses the 30s mark on lower-end hardware.
            let handle = app.handle().clone();
            let log_dir_bg = log_dir.clone();
            thread::spawn(move || {
                if wait_for_port(port, Duration::from_secs(60)) {
                    startup_log_line(
                        &log_dir_bg,
                        &format!("next server up on 127.0.0.1:{}", port),
                    );
                    // Navigate to the studio route, not root. The landing
                    // page (root) is the marketing surface — the desktop app
                    // should drop the user directly into the studio.
                    // /studio was renamed from /app in the post-1.0 refactor;
                    // 0620-fix: failing to update this URL caused the desktop
                    // to show a 404 (it loaded the landing page root, which
                    // is not a redirect target).
                    let url_str = format!("http://127.0.0.1:{}/studio", port);
                    match tauri::Url::parse(&url_str) {
                        Ok(url) => match handle.get_webview_window("main") {
                            Some(window) => {
                                if let Err(e) = window.navigate(url) {
                                    startup_log_line(
                                        &log_dir_bg,
                                        &format!("window.navigate failed: {}", e),
                                    );
                                }
                            }
                            None => startup_log_line(
                                &log_dir_bg,
                                "main window not found for navigation",
                            ),
                        },
                        Err(e) => startup_log_line(
                            &log_dir_bg,
                            &format!("parse sidecar url: {}", e),
                        ),
                    }
                } else {
                    startup_log_line(
                        &log_dir_bg,
                        "next server did not come up within 60s — see sidecar.log",
                    );
                    // Don't close the window — leave the loading screen
                    // visible so the user sees SOMETHING and can find
                    // logs rather than facing an instant exit.
                }
            });

            // ---- step 6: system tray
            //
            // FEAT-TRAY-AUTOSTART (2026-05-20): the user closes the
            // window expecting the app to "quit" but actually it hides
            // to tray so the WebView (and its browser-only auto-poster)
            // stays alive. The tray icon is the only path back to a
            // visible window AND the only path to a real shutdown.
            //
            // - Left click on the tray icon → show + focus window.
            // - "Öffnen" menu item → same.
            // - "Beenden" menu item → kill_sidecar() then app.exit(0).
            //   This is the only place the sidecar dies under normal
            //   shutdown (the CloseRequested handler above no longer
            //   kills it because closing is now "hide to tray").
            let show_item = MenuItem::with_id(app, "show", "Öffnen", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let tray_icon = app
                .default_window_icon()
                .ok_or("no default window icon for tray")?
                .clone();

            let _tray = TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .tooltip("MashupForge")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        kill_sidecar(app, "Tray Quit");
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // V107.1-OAUTH: register `mashupforge://` at runtime for dev
            // builds (release builds get it from tauri.conf.json via the
            // bundler). V1.3.6-OAUTH: also call `register_all()` on
            // Windows release builds as a defense against the NSIS
            // bundler bug (Tauri PR #9833) where the registry key
            // didn't get written. The bundle identifier is the same
            // either way (`com.4nevercompany.mashupforge`) so
            // `register_all()` re-writing the key is idempotent.
            //
            // Without this fallback, users who installed a build
            // predating PR #9833 (or whose registry was wiped during
            // an NSIS reinstall) would never get deep-link events:
            // Higgsfield's `mashupforge://oauth/callback?code=...`
            // redirect would have no OS handler, the URL would
            // silently fail, and the user would see the "app
            // reloads but doesn't connect" symptom.
            #[cfg(any(debug_assertions, target_os = "windows"))]
            {
                if let Err(e) = app.deep_link().register_all() {
                    log::warn!("[tauri] deep_link register_all failed: {}", e);
                }
            }
            let app_handle_for_dl = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event
                    .urls()
                    .iter()
                    .map(|u| u.to_string())
                    .collect();
                log::info!("[tauri] deep-link received: {:?}", urls);
                // V107.1-OAUTH: emit the event on the AppHandle, not
                // the WebviewWindow. `WebviewWindow` has no `emit`
                // method; that's on `Manager` / `Emitter` (which the
                // AppHandle implements). The frontend listener in
                // components/Settings/HiggsfieldConnection.tsx
                // subscribes to "deep-link" and we want it to fire
                // regardless of which window the event originated
                // from, so AppHandle is the right scope.
                let _ = app_handle_for_dl.emit("deep-link", urls);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // FEAT-TRAY-AUTOSTART (2026-05-20): the X button hides the
            // window to the system tray instead of quitting the app. The
            // Node sidecar (and therefore the open WebView) stays alive
            // so the browser-only auto-poster can keep firing while the
            // user thinks the app is "closed." Real shutdown is reached
            // exclusively through the tray's "Beenden" menu item, which
            // calls kill_sidecar() then app.exit(0) — see the tray setup
            // inside .setup() above.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let log_dir = window
                    .app_handle()
                    .path()
                    .app_data_dir()
                    .ok()
                    .map(|p| p.join("logs"));
                if let Some(ref ld) = log_dir {
                    startup_log_line(ld, "CloseRequested: hiding to tray (sidecar stays alive)");
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
