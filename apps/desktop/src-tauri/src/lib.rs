mod hittest;

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hittest::{Activity, ClickThrough, Rect};
use tauri::{AppHandle, Manager, State};

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
    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![set_hit_box, focus_pet, touch_activity, idle_ms])
        .setup(move |app| {
            spawn_cursor_poll(app.handle().clone(), state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Chalito desktop app");
}
