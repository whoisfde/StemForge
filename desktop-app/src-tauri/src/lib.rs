use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const LICENSE_VERIFY_URL: &str = "https://www.whoisfde.com/api/license/verify";
// How often a running copy re-checks its license. A revoke on the
// dashboard takes effect the next time this fires (or at next launch),
// not instantly — there's no persistent connection to push a revoke out
// immediately, and a multi-hour window is a reasonable tradeoff for a
// single-user local companion app.
const RECHECK_INTERVAL_SECS: u64 = 6 * 60 * 60;

struct CompanionProcess(Mutex<Option<Child>>);

#[derive(Serialize, Deserialize, Clone)]
struct StoredLicense {
    license_key: String,
}

#[derive(Serialize, Clone)]
struct VerifyResult {
    valid: bool,
    reason: Option<String>,
    network_error: bool,
}

fn license_file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("license.json"))
}

fn read_stored_license(app: &AppHandle) -> Option<StoredLicense> {
    let path = license_file_path(app)?;
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn write_stored_license(app: &AppHandle, license: &StoredLicense) -> std::io::Result<()> {
    let path = license_file_path(app)
        .ok_or_else(|| std::io::Error::other("could not resolve app data dir"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string(license).unwrap_or_default())
}

// Never errors out to the caller on a network problem — that's reported
// as `network_error: true` so callers can choose to fail open (a launch
// check leaves a currently-running companion server alone) rather than
// treating "couldn't reach the server" the same as "server said no".
async fn verify_license_key(key: &str) -> VerifyResult {
    let client = reqwest::Client::new();
    let res = client
        .post(LICENSE_VERIFY_URL)
        .timeout(Duration::from_secs(10))
        .json(&serde_json::json!({ "license_key": key }))
        .send()
        .await;

    match res {
        Ok(resp) => match resp.json::<serde_json::Value>().await {
            Ok(body) => VerifyResult {
                valid: body.get("valid").and_then(|v| v.as_bool()).unwrap_or(false),
                reason: body.get("reason").and_then(|v| v.as_str()).map(|s| s.to_string()),
                network_error: false,
            },
            Err(_) => VerifyResult { valid: false, reason: None, network_error: true },
        },
        Err(_) => VerifyResult { valid: false, reason: None, network_error: true },
    }
}

fn spawn_companion(app: &tauri::AppHandle) -> Option<Child> {
    let resource_dir = match app.path().resource_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("[stemforge-desktop] failed to resolve resource dir: {e}");
            return None;
        }
    };

    let binary_path = resource_dir
        .join("stemforge-server")
        .join("stemforge-server");

    match Command::new(&binary_path).spawn() {
        Ok(child) => {
            println!(
                "[stemforge-desktop] spawned companion server pid={} from {:?}",
                child.id(),
                binary_path
            );
            Some(child)
        }
        Err(e) => {
            eprintln!(
                "[stemforge-desktop] failed to spawn companion server at {:?}: {e}",
                binary_path
            );
            None
        }
    }
}

fn kill_companion(state: &CompanionProcess) {
    let mut guard = state.0.lock().unwrap();
    if let Some(mut child) = guard.take() {
        println!("[stemforge-desktop] killing companion server pid={}", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

// Shared by the startup check and the periodic re-check: verifies whatever
// license is stored and brings the companion server's running state in
// line with the result. A network error leaves things exactly as they
// were (fail open) — only an explicit "not valid" answer from the server
// shuts the companion server down.
async fn check_license_and_enforce(app: AppHandle) {
    let Some(stored) = read_stored_license(&app) else {
        let _ = app.emit("stemforge://license-required", ());
        return;
    };

    let result = verify_license_key(&stored.license_key).await;

    if result.network_error {
        let _ = app.emit("stemforge://license-check-error", ());
        return;
    }

    if result.valid {
        let state = app.state::<CompanionProcess>();
        let mut guard = state.0.lock().unwrap();
        if guard.is_none() {
            *guard = spawn_companion(&app);
        }
        drop(guard);
        let _ = app.emit("stemforge://license-ok", ());
    } else {
        kill_companion(&app.state::<CompanionProcess>());
        let _ = app.emit("stemforge://license-revoked", result.reason.clone());
    }
}

#[tauri::command]
async fn activate_license(app: AppHandle, key: String) -> Result<VerifyResult, String> {
    let key = key.trim().to_uppercase();
    if key.is_empty() {
        return Err("Enter a license key".into());
    }

    let result = verify_license_key(&key).await;
    if result.network_error {
        return Err("Could not reach the license server. Check your connection and try again.".into());
    }

    if result.valid {
        let stored = StoredLicense { license_key: key };
        if let Err(e) = write_stored_license(&app, &stored) {
            eprintln!("[stemforge-desktop] failed to save license: {e}");
        }
        let state = app.state::<CompanionProcess>();
        let mut guard = state.0.lock().unwrap();
        if guard.is_none() {
            *guard = spawn_companion(&app);
        }
    }

    Ok(result)
}

#[tauri::command]
fn has_stored_license(app: AppHandle) -> bool {
    read_stored_license(&app).is_some()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(CompanionProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![activate_license, has_stored_license])
        .setup(|app| {
            let handle = app.handle().clone();

            // Optimistic spawn: if a license is already on file, start the
            // companion server right away rather than waiting on a network
            // round-trip first — check_license_and_enforce (called right
            // below, then every RECHECK_INTERVAL_SECS) is what shuts it
            // back down if that license turns out to be invalid/revoked.
            if read_stored_license(&handle).is_some() {
                let child = spawn_companion(&handle);
                *app.state::<CompanionProcess>().0.lock().unwrap() = child;
            }

            let check_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    check_license_and_enforce(check_handle.clone()).await;
                    tokio::time::sleep(Duration::from_secs(RECHECK_INTERVAL_SECS)).await;
                }
            });

            match app.autolaunch().is_enabled() {
                Ok(false) => {
                    if let Err(e) = app.autolaunch().enable() {
                        eprintln!("[stemforge-desktop] failed to enable autostart: {e}");
                    }
                }
                Ok(true) => {}
                Err(e) => {
                    eprintln!("[stemforge-desktop] failed to check autostart state: {e}");
                }
            }

            let check_updates_item =
                MenuItem::with_id(app, "check-updates", "Check for Updates", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&check_updates_item, &quit_item])?;

            let icon = app.default_window_icon().cloned();

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip(format!("StemForge v{}", app.package_info().version))
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id().as_ref() == "quit" {
                        kill_companion(&app.state::<CompanionProcess>());
                        app.exit(0);
                    } else if event.id().as_ref() == "check-updates" {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("stemforge://check-for-updates", ());
                    }
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
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(icon) = icon {
                tray_builder = tray_builder.icon(icon);
            }

            tray_builder.build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            kill_companion(&app_handle.state::<CompanionProcess>());
        }
    });
}
