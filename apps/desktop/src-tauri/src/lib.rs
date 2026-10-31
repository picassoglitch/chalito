mod agent;
mod autostart;
mod cli_install;
mod computer;
mod copies;
mod copies_macos;
mod copies_windows;
mod hittest;
mod idle_os;
mod ipc_client;
mod voice_hotkey;
#[cfg(debug_assertions)]
mod loopback;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent::Supervisor;
use computer::{ComputerUi, SharedUi, View};
use hittest::{Activity, ClickThrough, Rect};
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
#[cfg(not(target_os = "linux"))]
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt as _;
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
fn set_hit_box(app: AppHandle, state: State<'_, SharedState>, rect: Option<Rect>) {
    if let Ok(mut s) = state.lock() {
        s.hit = rect;
    }
    #[cfg(target_os = "linux")]
    apply_input_region(&app, state.inner());
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

/// Linux: clicks land only inside the hit box, set as the window's input region (hittest.rs).
#[cfg(target_os = "linux")]
fn apply_input_region(app: &AppHandle, state: &SharedState) {
    use gtk::prelude::WidgetExt as _;
    let Some(pet) = app.get_webview_window(PET) else { return };
    // Before the GDK window is realized there is nothing to shape (tao panics there too).
    if !pet.is_visible().unwrap_or(false) {
        return;
    }
    let (Ok(inner), Ok(scale), Ok(size)) = (pet.inner_position(), pet.scale_factor(), pet.inner_size()) else {
        return;
    };
    let logical = (f64::from(size.width) / scale, f64::from(size.height) / scale);
    let (win, state) = (pet.clone(), state.clone());
    let _ = pet.run_on_main_thread(move || {
        // Read the box when this runs, in queue order: an older call can't overwrite a newer box.
        let hit = state.lock().ok().and_then(|s| s.hit);
        let region = hit.and_then(|h| hittest::local_region(&h, (f64::from(inner.x), f64::from(inner.y)), scale, logical));
        let Some(gdk) = win.gtk_window().ok().and_then(|w| w.window()) else { return };
        let shape = match region {
            Some((x, y, w, h)) => gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(x, y, w, h)),
            None => gtk::cairo::Region::create(),
        };
        gdk.input_shape_combine_region(&shape, 0, 0);
    });
}

/// L4 "knock": bring the pet forward and take focus. Refused below L4.
#[tauri::command]
fn focus_pet(app: AppHandle, state: State<'_, SharedState>, level: String) -> Result<(), String> {
    if !hittest::may_focus(&level) {
        return Err("focus is only taken at L4".into());
    }
    let pet = app.get_webview_window(PET).ok_or("no pet window")?;
    // Linux keeps the hit box as its input region: clearing it would block the whole window.
    if cfg!(not(target_os = "linux")) {
        pet.set_ignore_cursor_events(false).map_err(|e| e.to_string())?;
        if let Ok(mut s) = state.lock() {
            s.click.assume(false);
        }
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

/// Milliseconds since the last input (the presence reporter's idle signal, the pet's sleepiness): the
/// cursor poll, or the desktop's own count where it sees more (idle_os.rs). Off the main thread: D-Bus.
#[tauri::command]
async fn idle_ms(state: State<'_, SharedState>) -> Result<u64, String> {
    let poll = state.lock().map_or(u64::MAX, |s| s.activity.idle_ms(now_ms()));
    let os = tauri::async_runtime::spawn_blocking(idle_os::idle_ms).await.ok().flatten();
    Ok(idle_os::combine(poll, os))
}

/// This system's glibc version ("2.39"), or None off glibc. The updater refuses a build that needs a newer one.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[tauri::command]
fn libc_version() -> Option<String> {
    // SAFETY: gnu_get_libc_version returns a static NUL-terminated string.
    let v = unsafe { std::ffi::CStr::from_ptr(libc::gnu_get_libc_version()) };
    v.to_str().ok().map(str::to_owned)
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
#[tauri::command]
fn libc_version() -> Option<String> {
    None
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

/// Gap between the pet and the screen's right edge, in logical pixels.
const PET_MARGIN: f64 = 24.0;

/// Bottom-right of the work area, the window's bottom on the taskbar/dock: the pet stands on the
/// desktop's edge, out of the way, instead of the middle where the window manager drops it.
fn pet_spot(area: (i32, i32, u32, u32), window: (u32, u32), margin: i32) -> (i32, i32) {
    let (ax, ay, aw, ah) = area;
    let (ww, wh) = window;
    let x = ax + (aw as i32 - ww as i32 - margin).max(0);
    let y = ay + (ah as i32 - wh as i32).max(0);
    (x, y)
}

fn place_pet(w: &tauri::WebviewWindow) {
    if let (Ok(Some(m)), Ok(size), Ok(scale)) = (w.primary_monitor(), w.outer_size(), w.scale_factor()) {
        let a = m.work_area();
        // The window's pixels are at the scale it was made on; the work area's at the primary's.
        let size = size.to_logical::<f64>(scale).to_physical::<u32>(m.scale_factor());
        let margin = (PET_MARGIN * m.scale_factor()).round() as i32;
        let (x, y) = pet_spot((a.position.x, a.position.y, a.size.width, a.size.height), (size.width, size.height), margin);
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
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

/// The tray's "Iniciar con la computadora" item, kept so the panel's switch can tick it too.
#[derive(Default)]
struct AutostartItem(Mutex<Option<CheckMenuItem<tauri::Wry>>>);

/// Linux: the XDG autostart folder and the plugin's old one (autostart::xdg).
#[cfg(target_os = "linux")]
fn xdg_dirs(app: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = autostart::xdg::dir(&home, std::env::var_os("XDG_CONFIG_HOME").as_deref());
    Ok((dir, autostart::xdg::legacy_dir(&home)))
}

/// Linux: the program this copy registers.
#[cfg(target_os = "linux")]
fn xdg_target() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(autostart::launch_target(std::env::var_os("APPIMAGE"), std::env::var_os("APPDIR"), exe))
}

fn os_autostart_set(app: &AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let (dir, legacy) = xdg_dirs(app)?;
        let r = if enabled {
            autostart::xdg::enable(&dir, &xdg_target()?)
        } else {
            autostart::xdg::disable(&dir, &legacy)
        };
        r.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let launch = app.autolaunch();
        let r = if enabled { launch.enable() } else { launch.disable() };
        r.map_err(|e| e.to_string())
    }
}

fn os_autostart_enabled(app: &AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        autostart::xdg::is_enabled(&xdg_dirs(app)?.0).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        app.autolaunch().is_enabled().map_err(|e| e.to_string())
    }
}

/// Turns start-with-the-computer on or off now, saves the person's choice and ticks the tray item.
/// Returns what the OS has afterwards.
fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    os_autostart_set(app, enabled)?;
    if let Ok(dir) = app.path().app_config_dir() {
        if let Err(e) = autostart::write(&dir, autostart::Pref { enabled }) {
            eprintln!("autostart: saving the choice failed: {e}");
        }
    }
    let now = os_autostart_enabled(app).unwrap_or(enabled);
    if let Some(slot) = app.try_state::<AutostartItem>() {
        if let Some(item) = slot.0.lock().ok().and_then(|g| g.clone()) {
            let _ = item.set_checked(now);
        }
    }
    Ok(now)
}

/// Whether Chalito starts with the computer (the panel's switch).
#[tauri::command]
fn autostart_status(app: AppHandle) -> bool {
    os_autostart_enabled(&app).unwrap_or(false)
}

/// Panel only: the person's switch.
#[tauri::command]
fn set_autostart(app: AppHandle, window: tauri::Window, enabled: bool) -> Result<bool, String> {
    if window.label() != "panel" {
        return Err("not allowed".into());
    }
    apply_autostart(&app, enabled)
}

/// Panel only: the OS folder picker for a workspace. The agent then asks the OS itself before it
/// adds the folder (`addWorkspace`); this only returns the path the person chose, or null.
#[tauri::command]
async fn pick_folder(app: AppHandle, window: tauri::Window) -> Result<Option<String>, String> {
    if window.label() != "panel" {
        return Err("not allowed".into());
    }
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| p.display().to_string()))
}

/// Other copies of Chalito (copies.rs): what the panel's notice lists. Nothing in a dev build,
/// which isn't a copy the person installed and would list every real AppImage as old.
fn copies_report_now(app: &AppHandle) -> Result<copies::Report, String> {
    if cfg!(debug_assertions) {
        return Ok(copies::Report::default());
    }
    let mut r = copies_files(app)?;
    r.instances = copies::others(&copies::processes(), std::process::id());
    Ok(r)
}

#[cfg(target_os = "linux")]
fn copies_ctx(app: &AppHandle) -> Result<copies::Ctx, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(copies::Ctx::from_env(home, xdg_target()?))
}

#[cfg(target_os = "linux")]
fn copies_files(app: &AppHandle) -> Result<copies::Report, String> {
    Ok(copies_ctx(app)?.report())
}

#[cfg(not(target_os = "linux"))]
fn current_exe() -> Result<std::path::PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

/// Windows: what copies_windows.rs reads (registry, Downloads and Desktop known folders).
#[cfg(windows)]
fn copies_win(app: &AppHandle) -> Result<copies_windows::Inputs, String> {
    let folders = [app.path().download_dir(), app.path().desktop_dir()].into_iter().flatten().collect();
    Ok(copies_windows::os::inputs(current_exe()?, folders))
}

#[cfg(windows)]
fn copies_files(app: &AppHandle) -> Result<copies::Report, String> {
    Ok(copies_windows::report(&copies_win(app)?))
}

/// macOS asks for permission the first time an app reads Downloads or Desktop: that waits for the
/// person's click ("Revisar Descargas y Escritorio"), then holds for the session.
#[derive(Default)]
struct CopiesDownloads(std::sync::atomic::AtomicBool);

/// macOS: what copies_macos.rs reads (bundles, .dmg files, the LaunchAgent, LaunchServices).
#[cfg(target_os = "macos")]
fn copies_mac(app: &AppHandle, downloads: bool) -> Result<copies_macos::Inputs, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let p = app.path();
    let (dl, desk) = if downloads { (p.download_dir().ok(), p.desktop_dir().ok()) } else { (None, None) };
    Ok(copies_macos::os::inputs(current_exe()?, home, dl, desk))
}

#[cfg(target_os = "macos")]
fn copies_downloads_on(app: &AppHandle) -> bool {
    app.try_state::<CopiesDownloads>().is_some_and(|s| s.0.load(Ordering::Relaxed))
}

#[cfg(target_os = "macos")]
fn copies_files(app: &AppHandle) -> Result<copies::Report, String> {
    Ok(copies_macos::report(&copies_mac(app, copies_downloads_on(app))?))
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
fn copies_files(_app: &AppHandle) -> Result<copies::Report, String> {
    Ok(copies::Report { running: current_exe()?.display().to_string(), ..Default::default() })
}

/// After "Usar esta copia": done only when chalito:// (and autostart, if it was on) read back as
/// this copy. "None" isn't done either: the write didn't land or couldn't be read back.
#[cfg(any(windows, target_os = "macos"))]
fn copies_check_fixed(app: &AppHandle, before: &copies::Report) -> Result<(), String> {
    let after = copies_files(app)?;
    if after.handler != copies::Link::Ours {
        Err(copies::HANDLER_NOT_SET.into())
    } else if before.autostart != copies::Link::None && after.autostart != copies::Link::Ours {
        Err(copies::AUTOSTART_NOT_SET.into())
    } else {
        Ok(())
    }
}

/// The same writers the app already uses: the deep-link plugin's HKCU key and auto-launch's Run
/// value (only when autostart is on). Reads first, writes after.
#[cfg(windows)]
fn copies_use_this_os(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_deep_link::DeepLinkExt as _;
    let before = copies_files(app)?;
    app.deep_link().register("chalito").map_err(|e| e.to_string())?;
    if before.autostart != copies::Link::None {
        app.autolaunch().enable().map_err(|e| e.to_string())?;
    }
    copies_check_fixed(app, &before)
}

/// LaunchServices for chalito://, and auto-launch's LaunchAgent (only when autostart is on).
/// From a DMG or a translocated path it refuses: those paths don't last.
#[cfg(target_os = "macos")]
fn copies_use_this_os(app: &AppHandle) -> Result<(), String> {
    let before = copies_files(app)?;
    if before.placement != copies::Placement::Ok {
        return Err("bad_placement".into());
    }
    if let Some(bundle) = copies_macos::bundle_of(&current_exe()?) {
        if let Err(e) = copies_macos::os::claim_handler(&bundle) {
            eprintln!("copies: claiming chalito://: {e}");
        }
    }
    if before.autostart != copies::Link::None {
        app.autolaunch().enable().map_err(|e| e.to_string())?;
    }
    copies_check_fixed(app, &before)
}

#[cfg(target_os = "linux")]
fn copies_use_this_os(app: &AppHandle) -> Result<(), String> {
    copies_ctx(app)?.use_this().map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
fn copies_use_this_os(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn copies_trash_one(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("not allowed".into());
    }
    let ctx = copies_ctx(app)?;
    copies::may_trash(path, &ctx.running, &ctx.copies()).map_err(|r| r.code().to_string())?;
    copies::trash(path, &ctx.data_home).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn copies_trash_one(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("not allowed".into());
    }
    let i = copies_win(app)?;
    copies::may_trash(path, &i.running, &copies_windows::found(&i)).map_err(|r| r.code().to_string())?;
    copies_windows::os::trash(path).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn copies_trash_one(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("not allowed".into());
    }
    let i = copies_mac(app, copies_downloads_on(app))?;
    copies::may_trash(path, &i.running, &copies_macos::found(&i)).map_err(|r| r.code().to_string())?;
    copies_macos::os::trash(path).map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
fn copies_trash_one(_app: &AppHandle, _path: &std::path::Path) -> Result<(), String> {
    Err(copies::Refusal::NotACopy.code().into())
}

/// Windows: that install's own uninstaller, visible, after copies_windows::may_uninstall.
#[cfg(windows)]
fn copies_uninstall_one(id: &str) -> Result<(), String> {
    let running = copies_windows::running_forms(&current_exe()?);
    let u = copies_windows::may_uninstall(id, &copies_windows::os::entries(), &running).map_err(|r| r.code().to_string())?;
    copies_windows::os::launch(&u).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn copies_uninstall_one(_id: &str) -> Result<(), String> {
    Err(copies::Refusal::NotACopy.code().into())
}

#[cfg(target_os = "macos")]
fn copies_show_applications_os(app: &AppHandle) -> Result<(), String> {
    // The click is consent to look in Downloads and Desktop, where a translocated original sits.
    let i = copies_mac(app, true)?;
    let reveal = match copies_macos::report(&i).placement {
        copies::Placement::Dmg => copies_macos::bundle_of(&i.running).into_iter().collect(),
        copies::Placement::Translocated => copies_macos::originals(&i),
        copies::Placement::Ok => Vec::new(),
    };
    copies_macos::os::show_applications(&reveal).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn copies_show_applications_os(_app: &AppHandle) -> Result<(), String> {
    Err("not allowed".into())
}

/// Panel only: the notice's check, run again each time the panel asks.
#[tauri::command]
async fn copies_report(app: AppHandle, window: tauri::Window) -> Result<copies::Report, String> {
    if window.label() != "panel" {
        return Err("not allowed".into());
    }
    tauri::async_runtime::spawn_blocking(move || copies_report_now(&app)).await.map_err(|e| e.to_string())?
}

/// Panel only, on the person's click: autostart (if on) and chalito:// links start this copy.
#[tauri::command]
async fn copies_use_this(app: AppHandle, window: tauri::Window) -> Result<copies::Report, String> {
    if window.label() != "panel" || cfg!(debug_assertions) {
        return Err("not allowed".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        copies_use_this_os(&app)?;
        copies_report_now(&app)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Panel only, on the person's click: one old copy to the trash, after copies::may_trash.
#[tauri::command]
async fn copies_trash(app: AppHandle, window: tauri::Window, path: String) -> Result<copies::Report, String> {
    if window.label() != "panel" {
        return Err("not allowed".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        copies_trash_one(&app, std::path::Path::new(&path))?;
        copies_report_now(&app)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Panel only, on the person's click: opens the folder of a copy a fresh check still lists.
#[tauri::command]
async fn copies_reveal(app: AppHandle, window: tauri::Window, path: String) -> Result<copies::Report, String> {
    if window.label() != "panel" || cfg!(debug_assertions) {
        return Err("not allowed".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !copies_files(&app)?.copies.iter().any(|c| c.path == path) {
            return Err(copies::Refusal::NotACopy.code().to_string());
        }
        tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())?;
        copies_report_now(&app)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Panel only, on the person's click (Windows): starts another install's own uninstaller.
#[tauri::command]
async fn copies_uninstall(app: AppHandle, window: tauri::Window, id: String) -> Result<copies::Report, String> {
    if window.label() != "panel" || cfg!(debug_assertions) {
        return Err("not allowed".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        copies_uninstall_one(&id)?;
        copies_report_now(&app)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Panel only, on the person's click (macOS): from now on the check reads Downloads and Desktop.
#[tauri::command]
async fn copies_scan_downloads(app: AppHandle, window: tauri::Window) -> Result<copies::Report, String> {
    if window.label() != "panel" || cfg!(debug_assertions) {
        return Err("not allowed".into());
    }
    if let Some(s) = app.try_state::<CopiesDownloads>() {
        s.0.store(true, Ordering::Relaxed);
    }
    tauri::async_runtime::spawn_blocking(move || copies_report_now(&app)).await.map_err(|e| e.to_string())?
}

/// Panel only, on the person's click (macOS): opens Applications so the app can be dragged there.
#[tauri::command]
async fn copies_show_applications(app: AppHandle, window: tauri::Window) -> Result<copies::Report, String> {
    if window.label() != "panel" || cfg!(debug_assertions) {
        return Err("not allowed".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        copies_show_applications_os(&app)?;
        copies_report_now(&app)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Panel only, on the person's click: asks another Chalito process from the notice to quit.
#[tauri::command]
async fn copies_close(app: AppHandle, window: tauri::Window, pid: u32) -> Result<copies::Report, String> {
    if window.label() != "panel" {
        return Err("not allowed".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let listed = || copies::others(&copies::processes(), std::process::id()).iter().any(|i| i.pid == pid);
        if cfg!(debug_assertions) {
            return Err("not allowed".to_string());
        }
        if !listed() {
            return Err("not_listed".to_string());
        }
        copies::terminate(pid).map_err(|e| e.to_string())?;
        let start = std::time::Instant::now();
        while listed() && start.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(200));
        }
        if listed() {
            return Err("still_running".to_string());
        }
        copies_report_now(&app)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tray icon: open the panel, "Detener control" (enabled while a session has control) and
/// "Iniciar con la computadora".
fn build_tray(app: &AppHandle) -> tauri::Result<MenuItem<tauri::Wry>> {
    let open = MenuItem::with_id(app, computer::TRAY_OPEN, "Abrir Chalito", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, computer::TRAY_STOP, "Detener control", false, None::<&str>)?;
    // The OS locale (what the panel's navigator.language follows); Spanish when unknown.
    let lang = sys_locale::get_locale().unwrap_or_default();
    let start = CheckMenuItem::with_id(
        app,
        autostart::TRAY_ITEM,
        autostart::tray_label(&lang),
        true,
        os_autostart_enabled(app).unwrap_or(false),
        None::<&str>,
    )?;
    if let Some(slot) = app.try_state::<AutostartItem>() {
        if let Ok(mut g) = slot.0.lock() {
            *g = Some(start.clone());
        }
    }
    let menu = Menu::with_items(app, &[&open, &stop, &start])?;
    let mut tray = TrayIconBuilder::with_id("chalito").menu(&menu).tooltip("Chalito").on_menu_event(|app, event| {
        match event.id().as_ref() {
            computer::TRAY_STOP => computer_kill(app, "tray"),
            autostart::TRAY_ITEM => {
                let on = os_autostart_enabled(app).unwrap_or(false);
                if let Err(e) = apply_autostart(app, !on) {
                    eprintln!("autostart: {e}");
                }
            }
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

/// ~30 Hz: read the global cursor, toggle click-through on change (not on Linux), note activity.
fn spawn_cursor_poll(app: AppHandle, state: SharedState) {
    #[cfg(target_os = "linux")]
    let mut shaped = false;
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL);
        let Some(pet) = app.get_webview_window(PET) else { continue };
        // Toggling before the GDK window is realized can panic on Linux (tao): wait until shown.
        if !pet.is_visible().unwrap_or(false) {
            continue;
        }
        // Linux: shape the window once even if the webview never sends a box (WebGL failed),
        // or the whole transparent window would swallow clicks on the desktop.
        #[cfg(target_os = "linux")]
        if !shaped {
            shaped = true;
            apply_input_region(&app, &state);
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
        // Linux: the input region does it (apply_input_region); the poll only tracks activity.
        if let (Some(ignore), false) = (change, cfg!(target_os = "linux")) {
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
        .plugin(tauri_plugin_dialog::init())
        // Computer control's kill switch. The shortcut is registered only while it's enabled.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && shortcut == &kill_hotkey() {
                        computer_kill(app, "hotkey");
                    }
                    if let Some(v) = app.try_state::<voice_hotkey::VoiceHotkey>() {
                        voice_hotkey::on_shortcut(app, &v, shortcut, event.state());
                    }
                })
                .build(),
        )
        .manage(state.clone())
        .manage(computer_ui.clone())
        .manage(AutostartItem::default())
        .manage(CopiesDownloads::default())
        .manage(voice_hotkey::VoiceHotkey::default());
    // Linux writes its own XDG entry (autostart::xdg); the plugin would use ~/.config regardless.
    #[cfg(not(target_os = "linux"))]
    let builder =
        builder.plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None));
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
        libc_version,
        agent_status,
        agent_ipc,
        cli_status,
        install_cli,
        computer_stop,
        computer_permissions,
        computer_open_settings,
        autostart_status,
        set_autostart,
        pick_folder,
        copies_report,
        copies_use_this,
        copies_trash,
        copies_close,
        copies_reveal,
        copies_uninstall,
        copies_show_applications,
        copies_scan_downloads,
        voice_hotkey::set_voice_hotkey,
        loopback::sso_loopback
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        set_hit_box,
        focus_pet,
        touch_activity,
        idle_ms,
        libc_version,
        agent_status,
        agent_ipc,
        cli_status,
        install_cli,
        computer_stop,
        computer_permissions,
        computer_open_settings,
        autostart_status,
        set_autostart,
        pick_folder,
        copies_report,
        copies_use_this,
        copies_trash,
        copies_close,
        copies_reveal,
        copies_uninstall,
        copies_show_applications,
        copies_scan_downloads,
        voice_hotkey::set_voice_hotkey
    ]);
    builder
        .setup(move |app| {
            if let Some(pet) = app.get_webview_window(PET) {
                place_pet(&pet);
            }
            spawn_cursor_poll(app.handle().clone(), state.clone());
            // Start with the computer: on by default the first time; the person's choice after that.
            // Release builds only: a dev build must not register itself to start at login.
            if let (false, Ok(dir)) = (cfg!(debug_assertions), app.path().app_config_dir()) {
                match autostart::on_launch(autostart::read(&dir)) {
                    autostart::Launch::Enable => {
                        if let Err(e) = apply_autostart(app.handle(), true) {
                            eprintln!("autostart: {e}");
                        }
                    }
                    #[cfg(target_os = "linux")]
                    autostart::Launch::Repair => {
                        let r = xdg_dirs(app.handle()).and_then(|(d, l)| {
                            autostart::xdg::repair(&d, &l, &xdg_target()?).map_err(|e| e.to_string())
                        });
                        match r {
                            Ok(true) => eprintln!("autostart: entry repaired"),
                            Ok(false) => {}
                            Err(e) => eprintln!("autostart: {e}"),
                        }
                    }
                    _ => {}
                }
            }
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
            // Other copies, in launch.log; the panel's notice shows the same and offers the fixes.
            let h = handle.clone();
            std::thread::spawn(move || match copies_report_now(&h) {
                Ok(r) if r.autostart.needs_fix()
                    || r.handler.needs_fix()
                    || !r.instances.is_empty()
                    || !r.installs.is_empty()
                    || r.placement != copies::Placement::Ok =>
                {
                    eprintln!(
                        "copies: autostart {:?}, handler {:?}, {} other running, {} other installs, placement {:?}",
                        r.autostart,
                        r.handler,
                        r.instances.len(),
                        r.installs.len(),
                        r.placement
                    )
                }
                Ok(_) => {}
                Err(e) => eprintln!("copies: {e}"),
            });
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
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    #[test]
    fn libc_version_reads_glibc() {
        let v = super::libc_version().expect("glibc");
        assert_eq!(v.split('.').next().and_then(|m| m.parse::<u32>().ok()), Some(2), "{v}");
    }

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

    #[test]
    fn pet_sits_bottom_right_on_the_work_area() {
        // 1920×1080 with a 40 px taskbar at the bottom: feet on the taskbar, 24 px from the right.
        assert_eq!(super::pet_spot((0, 0, 1920, 1040), (220, 260), 24), (1676, 780));
        // A second monitor to the left, a top menu bar (macOS) shifting the work area down.
        assert_eq!(super::pet_spot((-1440, 25, 1440, 875), (220, 260), 24), (-244, 640));
        // A window wider or taller than the area stays inside it.
        assert_eq!(super::pet_spot((0, 0, 200, 200), (220, 260), 24), (0, 0));
    }

    /// Run in CI with `cargo test --release`: the loopback must not exist in release builds.
    #[test]
    fn dev_loopback_follows_debug_assertions() {
        assert_eq!(super::DEV_LOOPBACK, cfg!(debug_assertions));
        #[cfg(not(debug_assertions))]
        assert!(!super::DEV_LOOPBACK, "release build with the dev SSO loopback");
    }
}
