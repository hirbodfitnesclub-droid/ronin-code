//! Ronin Code — desktop shell.
//!
//! This crate does very little on purpose: it starts the local Node host
//! (bundled as a resource, run with a bundled Node runtime), waits until the
//! host answers on http://127.0.0.1:7331, then shows a single window pointed
//! at that URL. All product UI and logic live in the host + web GUI.

use std::{
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_updater::UpdaterExt;

const HOST_ADDR: &str = "127.0.0.1:7331";
const HOST_URL: &str = "http://127.0.0.1:7331";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);

/// The spawned host process, kept so it can be killed on exit.
#[derive(Default)]
struct HostState(Mutex<Option<Child>>);

fn kill_host(state: &HostState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Bundled Node first (resources/binaries/node[.exe] or the target-triple
/// name stage.mjs / CI download it under); system `node` is the dev fallback.
fn resolve_node(resource_dir: &std::path::Path) -> PathBuf {
    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node-x86_64-pc-windows-msvc.exe", "node"]
    } else {
        &["node", "node-x86_64-unknown-linux-gnu"]
    };
    for name in names {
        let candidate = resource_dir.join("binaries").join(name);
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("node")
}

/// Bundled host first; in dev (`cargo run` before staging) fall back to the
/// repo's `host/` two levels up from src-tauri.
fn resolve_host_dir(resource_dir: &std::path::Path) -> PathBuf {
    let bundled = resource_dir.join("host");
    if bundled.join("src").join("server.js").is_file() {
        return bundled;
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../host");
    if dev.join("src").join("server.js").is_file() {
        return dev;
    }
    bundled
}

fn spawn_host(app: &tauri::App) -> std::io::Result<Child> {
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let host_dir = resolve_host_dir(&resource_dir);
    Command::new(resolve_node(&resource_dir))
        .arg(host_dir.join("src").join("server.js"))
        .env("PORT", "7331")
        .env("RONIN_DESKTOP", "1")
        .current_dir(&host_dir)
        .spawn()
}

/// Std-only health check: one tiny manual HTTP GET /health per attempt.
/// No HTTP crate needed for a loopback check this small.
fn health_ok() -> bool {
    let Ok(mut stream) = TcpStream::connect(HOST_ADDR) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut body = String::new();
    let _ = stream.read_to_string(&mut body);
    body.contains("200") && body.contains("\"ok\"")
}

fn wait_for_health() -> bool {
    let start = Instant::now();
    while start.elapsed() < HEALTH_TIMEOUT {
        if health_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Best-effort startup update check.
///
/// NOTE: the updater endpoint and pubkey in tauri.conf.json are PLACEHOLDERS
/// until release signing keys exist — requests to them will simply fail.
/// That must never break startup, so every error here is swallowed: offline,
/// placeholder endpoint, and "no update available" are all fine outcomes.
/// A downloaded update is installed by the plugin and applies on next restart.
async fn check_for_updates(app: tauri::AppHandle) {
    let Ok(updater) = app.updater() else { return };
    let Ok(Some(update)) = updater.check().await else {
        return;
    };
    let _ = update
        .download_and_install(|_chunk_len, _content_len| {}, || {})
        .await;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(HostState::default())
        .setup(|app| {
            // Update check runs in the background; startup never waits on it.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { check_for_updates(handle).await });

            // Start the host. If spawning itself fails we still show the
            // window below — its error state is more useful than no window.
            match spawn_host(app) {
                Ok(child) => {
                    if let Ok(mut guard) = app.state::<HostState>().0.lock() {
                        *guard = Some(child);
                    }
                }
                Err(e) => eprintln!("Ronin Code: failed to start local host: {e}"),
            }

            // Create the window hidden, pointed at the host URL. There is no
            // splash page asset, so the hidden window *is* the splash state:
            // it is only shown once the host is healthy (see thread below).
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(HOST_URL.parse().unwrap()),
            )
            .title("Ronin Code")
            .inner_size(1440.0, 900.0)
            .min_inner_size(1024.0, 640.0)
            .decorations(true)
            .visible(false)
            .build()?;

            // Poll on a thread so the event loop is never blocked. On timeout
            // we show the window anyway: the host's own error page / state
            // then surfaces the problem instead of a silent hang.
            std::thread::spawn(move || {
                let _healthy = wait_for_health();
                let _ = window.show();
                let _ = window.set_focus();
            });
            Ok(())
        })
        // Kill the host when the main window closes.
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                kill_host(&window.state::<HostState>());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Ronin Code");

    // …and kill it on app exit too (covers quit paths without a close event).
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            kill_host(&app_handle.state::<HostState>());
        }
    });
}
