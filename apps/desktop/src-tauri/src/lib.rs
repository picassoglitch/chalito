mod agent;
mod cli_install;
mod computer;
mod hittest;
mod ipc_client;
#[cfg(debug_assertions)]
mod loopback;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent::Supervisor;
use computer::{ComputerUi, SharedUi, View};
use hittest::{Activity, ClickThrough, Rect};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Whether this build carries the dev-only SSO loopback (never in release; see loopback.rs).
pub const DEV_LOOPBACK: bool = cfg!(debug_assertions);

const PET: &str = "pet";
const POLL: Duration = Duration::from_millis(33);

#[derive(Default)]
struct Shared {
    hit: Option<Rect>,
    click: ClickThrough,
    activity: Activity,
}

type SharedState = Arc<Mutex<Shared>>;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The avatar's hit box in physical screen pixels, or null while it isn't drawn.
#[tauri::command]
fn set_hit_box(state: State<'_, SharedState>, rect: Option<Rect>) {
    if let Ok(mut s) = state.lock() {
        s.hit = rect;
    }
}

/// L4 "knock": bring the pet forward and take focus. Refused below L4.
#[tauri::command]
fn focus_pet(app: AppHandle, state: State<'_, SharedState>, level: String) -> Result<(), String> {
    if !hittest::may_focus(&level) {
        return Err("focus is only taken at L4".into());
    }
    let pet = app.get_webview_window(PET).ok_or("no pet window")?;
    pet.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;
    if let Ok(mut s) = state.lock() {
        s.click.assume(false);
    }
    pet.set_focusable(true).map_err(|e| e.to_string())?;
    pet.set_focus().map_err(|e| e.to_string())
}

/// Keyboard/clicks inside our own windows count as activity too.
#[tauri::command]
fn touch_activity(state: State<'_, SharedState>) {
    if let Ok(mut s) = state.lock() {
        s.activity.touch(now_ms());
    }
}

/// Milliseconds since the cursor last moved (the presence reporter's idle signal).
#[tauri::command]
fn idle_ms(state: State<'_, SharedState>) -> u64 {
    state.lock().map_or(u64::MAX, |s| s.activity.idle_ms(now_ms()))
}

/// The bundled agent's state (agent.rs), for the panel.
#[tauri::command]
fn agent_status(sup: State<'_, Supervisor>) -> agent::Status {
    sup.status()
}

/// The panel's calls to the local agent (ipc_client.rs; apps/desktop/src/lib/ipc.ts). Panel
/// only. Without an agent this app started, every call is `agent_ipc_unavailable`.
#[tauri::command]
async fn agent_ipc(
    app: AppHandle,
    window: tauri::Window,
    sup: State<'_, Supervisor>,
    method: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if window.label() != "panel" {
        return Err(ipc_client::UNAVAILABLE.into());
    }
    let token = sup.secret().ok_or(ipc_client::UNAVAILABLE)?.to_string();
    let home = app.path().home_dir().map_err(|_| ipc_client::UNAVAILABLE)?;
    let params = params.unwrap_or(serde_json::Value::Null);
    tauri::async_runtime::spawn_blocking(move || {
        ipc_client::call(&ipc_client::socket_path(&home), &token, &method, &params)
    })
    .await
    .map_err(|_| ipc_client::UNAVAILABLE.to_string())?
}

/// The computer-control kill switch: Ctrl+Alt+Esc (Ctrl+Option+Esc on macOS).
fn kill_hotkey() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Escape)
}

/// Ends computer control now and interrupts the sessions that had it (agent `computerKill`).
fn computer_kill(app: &AppHandle, via: &'static str) {
    let Some(sup) = app.try_state::<Supervisor>() else { return };
    let Some(token) = sup.secret().map(str::to_string) else { return };
    let Ok(home) = app.path().home_dir() else { return };
    std::thread::spawn(move || {
        let r = ipc_client::call(&ipc_client::socket_path(&home), &token, "computerKill", &computer::kill_params(via));
        if let Err(e) = r {
            eprintln!("computer control: kill via {via} failed: {e}");
        }
    });
}

/// The indicator's "Detener control" button, or the panel's.
#[tauri::command]
fn computer_stop(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    let via = match window.label() {
        computer::INDICATOR => "indicator",
        "panel" => "panel",
        _ => return Err("not allowed".into()),
    };
    computer_kill(&app, via);
    Ok(())
}

/// macOS Screen Recording / Accessibility as this app has them; Wayland on Linux.
#[tauri::command]
fn computer_permissions() -> computer::Permissions {
    computer::permissions()
}

/// Panel only: opens the macOS System Settings pane for one permission (fixed URLs).
#[tauri::command]
fn computer_open_settings(window: tauri::Window, pane: String) -> Result<(), String> {
    if window.label() != "panel" {
        return Err("not allowed".into());
    }
    let url = computer::settings_url(&pane).ok_or("unknown pane")?;
    std::process::Command::new("/usr/bin/open").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Top centre of the primary screen.
fn place_indicator(w: &tauri::WebviewWindow) {
    if let (Ok(Some(m)), Ok(size)) = (w.primary_monitor(), w.outer_size()) {
        let x = m.position().x + (m.size().width as i32 - size.width as i32) / 2;
        let _ = w.set_position(tauri::PhysicalPosition::new(x, m.position().y + 24));
    }
}

/// The hotkey is held only while computer control is enabled; (un)registered on the main thread.
fn set_kill_hotkey(app: &AppHandle, on: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let gs = handle.global_shortcut();
        let r = if on { gs.register(kill_hotkey()) } else { gs.unregister(kill_hotkey()) };
        if let Err(e) = r {
            eprintln!("computer control: hotkey {} {}: {e}", computer::HOTKEY_LABEL, if on { "register" } else { "unregister" });
        }
    });
}

/// Every 500 ms: ask the agent who has control, show or hide the indicator, enable the tray item,
/// and tell the agent whether the indicator is on screen (it acts only when it is).
fn spawn_computer_poll(app: AppHandle, ui: SharedUi, stop_item: Option<MenuItem<tauri::Wry>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(computer::POLL);
        let shown = ui.shown.load(Ordering::SeqCst);
        let next = match (app.try_state::<Supervisor>(), app.path().home_dir()) {
            (Some(sup), Ok(home)) => match sup.secret() {
                Some(token) => ipc_client::call(
                    &ipc_client::socket_path(&home),
                    token,
                    "computerStatus",
                    &computer::status_params(shown),
                )
                .map(|v| computer::parse_status(&v))
                .unwrap_or_default(),
                None => View::default(),
            },
            _ => View::default(),
        };
        let prev = match ui.view.lock() {
            Ok(mut v) => std::mem::replace(&mut *v, next.clone()),
            Err(_) => View::default(),
        };
        let ch = computer::changes(&prev, &next);
        let mut visible = false;
        if let Some(w) = app.get_webview_window(computer::INDICATOR) {
            if ch.show_indicator {
                if !w.is_visible().unwrap_or(false) {
                    place_indicator(&w);
                    let _ = w.show();
                }
                let _ = w.set_always_on_top(true);
                let _ = w.emit("computer-status", &next.active);
                visible = w.is_visible().unwrap_or(false);
            } else {
                let _ = w.hide();
            }
        }
        ui.shown.store(visible, Ordering::SeqCst);
        if let Some(item) = &stop_item {
            let _ = item.set_enabled(ch.stop_enabled);
        }
        if let Some(on) = ch.hotkey {
            set_kill_hotkey(&app, on);
        }
    });
}

/// Tray icon: open the panel, and "Detener control" (enabled while a session has control).
fn build_tray(app: &AppHandle) -> tauri::Result<MenuItem<tauri::Wry>> {
    let open = MenuItem::with_id(app, computer::TRAY_OPEN, "Abrir Chalito", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, computer::TRAY_STOP, "Detener control", false, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &stop])?;
    let mut tray = TrayIconBuilder::with_id("chalito").menu(&menu).tooltip("Chalito").on_menu_event(|app, event| {
        match event.id().as_ref() {
            computer::TRAY_STOP => computer_kill(app, "tray"),
            computer::TRAY_OPEN => {
                if let Some(panel) = app.get_webview_window("panel") {
                    let _ = panel.show();
                    let _ = panel.set_focus();
                }
            }
            _ => {}
        }
    });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(stop)
}

/// What installing the `chalito` command would do here (cli_install.rs), or that it's done.
fn cli_input(app: &AppHandle) -> Option<cli_install::Input> {
    let sidecar = agent::sidecar_path(&std::env::current_exe().ok()?)?;
    Some(cli_install::Input {
        os: cli_install::Os::current(),
        sidecar,
        home: app.path().home_dir().ok()?,
        appimage: std::env::var_os("APPIMAGE").is_some(),
        local_app_data: std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from),
        path_env: std::env::var("PATH").unwrap_or_default(),
    })
}

#[tauri::command]
fn cli_status(app: AppHandle) -> cli_install::CliStatus {
    cli_install::status(cli_input(&app).as_ref(), cli_install::Os::current())
}

/// Panel only, after the person confirmed there. Blocking work (the macOS admin prompt) runs
/// off the main thread.
#[tauri::command]
async fn install_cli(app: AppHandle, window: tauri::Window) -> Result<cli_install::CliStatus, cli_install::InstallError> {
    if window.label() != "panel" {
        return Err(cli_install::InstallError::Failed);
    }
    let input = cli_input(&app).ok_or(cli_install::InstallError::NoSidecar)?;
    tauri::async_runtime::spawn_blocking(move || {
        let plan = cli_install::plan(&input)?;
        cli_install::execute(&plan)?;
        Ok(cli_install::status(Some(&input), input.os))
    })
    .await
    .map_err(|_| cli_install::InstallError::Failed)?
}

/// ~30 Hz: read the global cursor, toggle click-through on change, note activity.
fn spawn_cursor_poll(app: AppHandle, state: SharedState) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL);
        let Some(pet) = app.get_webview_window(PET) else { continue };
        // Toggling before the GDK window is realized can panic on Linux (tao): wait until shown.
        if !pet.is_visible().unwrap_or(false) {
            continue;
        }
        let cursor = pet.cursor_position().ok().map(|p| (p.x, p.y));
        let change = match state.lock() {
            Ok(mut s) => {
                s.activity.observe(cursor, now_ms());
                let hit = s.hit;
                s.click.step(hit.as_ref(), cursor)
            }
            Err(_) => None,
        };
        if let Some(ignore) = change {
            let _ = pet.set_ignore_cursor_events(ignore);
        }
    });
}

/// Native Wayland reports the cursor at (0,0), which breaks click-through polling;
/// XWayland exposes the global pointer (VERIFIED_APIS, D-006). Must run before GTK starts.
#[cfg(target_os = "linux")]
fn prefer_xwayland() {
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}

#[cfg(not(target_os = "linux"))]
fn prefer_xwayland() {}

pub fn run() {
    prefer_xwayland();
    let state: SharedState = Arc::default();
    let computer_ui: SharedUi = Arc::new(ComputerUi::default());
    let builder = tauri::Builder::default()
        // First: a second launch (e.g. the OS opening a chalito:// link) hands its arguments
        // to this instance (the deep-link feature forwards the URL) and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(panel) = app.get_webview_window("panel") {
                let _ = panel.show();
                let _ = panel.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        // Computer control's kill switch. The shortcut is registered only while it's enabled.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && shortcut == &kill_hotkey() {
                        computer_kill(app, "hotkey");
                    }
                })
                .build(),
        )
        .manage(state.clone())
        .manage(computer_ui.clone());
    // The updater exists only in release builds: CI adds `plugins.updater` (public key +
    // endpoint) through the release config overlay. Dev and plain debug builds have no updater.
    let context = tauri::generate_context!();
    let builder = if has_updater(&context.config().plugins.0) {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        set_hit_box,
        focus_pet,
        touch_activity,
        idle_ms,
        agent_status,
        agent_ipc,
        cli_status,
        install_cli,
        computer_stop,
        computer_permissions,
        computer_open_settings,
        loopback::sso_loopback
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        set_hit_box,
        focus_pet,
        touch_activity,
        idle_ms,
        agent_status,
        agent_ipc,
        cli_status,
        install_cli,
        computer_stop,
        computer_permissions,
        computer_open_settings
    ]);
    builder
        .setup(move |app| {
            spawn_cursor_poll(app.handle().clone(), state.clone());
            // The bundled agent runs while the app is open (release builds; none in dev).
            let handle = app.handle();
            let exe = std::env::current_exe().ok();
            let sidecar = exe.as_deref().and_then(agent::sidecar_path);
            let home = handle.path().home_dir()?;
            let logs = handle.path().app_log_dir()?;
            // An AppImage update replaced the sidecar: keep the installed `chalito` current.
            if let Some(input) = cli_input(handle) {
                if let Ok(plan) = cli_install::plan(&input) {
                    cli_install::refresh_copy(&plan);
                }
            }
            // A fresh secret per launch: only the agent this app starts serves the panel's IPC.
            let secret = sidecar.as_ref().and_then(|_| ipc_client::new_secret().ok());
            app.manage(Supervisor::start(sidecar, home, logs, secret));
            // A tray that can't be created (no tray host on some Linux desktops) leaves the
            // hotkey and the indicator's own button as the kill switch.
            let stop_item = match build_tray(handle) {
                Ok(item) => Some(item),
                Err(e) => {
                    eprintln!("tray unavailable: {e}");
                    None
                }
            };
            spawn_computer_poll(handle.clone(), computer_ui.clone(), stop_item);
            Ok(())
        })
        .build(context)
        .expect("error while building the Chalito desktop app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(sup) = app.try_state::<Supervisor>() {
                    sup.stop();
                }
            }
        });
}

/// Whether the build carries an updater configuration (release overlay only).
fn has_updater(plugins: &std::collections::HashMap<String, serde_json::Value>) -> bool {
    plugins.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).is_some_and(|k| !k.is_empty())
}

#[cfg(test)]
mod tests {
    #[test]
    fn updater_only_with_a_public_key() {
        use std::collections::HashMap;
        let none: HashMap<String, serde_json::Value> = HashMap::new();
        assert!(!super::has_updater(&none));
        let empty = HashMap::from([("updater".to_string(), serde_json::json!({ "pubkey": "" }))]);
        assert!(!super::has_updater(&empty));
        let set = HashMap::from([("updater".to_string(), serde_json::json!({ "pubkey": "dW50cnVzdGVk", "endpoints": [] }))]);
        assert!(super::has_updater(&set));
    }

    /// Run in CI with `cargo test --release`: the loopback must not exist in release builds.
    #[test]
    fn dev_loopback_follows_debug_assertions() {
        assert_eq!(super::DEV_LOOPBACK, cfg!(debug_assertions));
        #[cfg(not(debug_assertions))]
        assert!(!super::DEV_LOOPBACK, "release build with the dev SSO loopback");
    }
}
