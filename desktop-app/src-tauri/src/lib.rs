use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent,
};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

struct CompanionProcess(Mutex<Option<Child>>);

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(CompanionProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            let child = spawn_companion(&handle);
            *app.state::<CompanionProcess>().0.lock().unwrap() = child;

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

            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_item])?;

            let icon = app.default_window_icon().cloned();

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id().as_ref() == "quit" {
                        kill_companion(&app.state::<CompanionProcess>());
                        app.exit(0);
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
