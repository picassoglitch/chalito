//! Computer control's on-screen side (apps/agent/src/computer): the always-on-top indicator
//! while a session has control, the tray item "Detener control", and the global kill hotkey.
//!
//! A thread polls the agent's `computerStatus` every 500 ms over the panel's local IPC
//! (ipc_client.rs) and reports whether the indicator is on screen. The agent refuses every action
//! unless a fresh poll says it is, so if this app closes, hangs or can't show the window, nothing
//! acts. The hotkey and the tray item call `computerKill`, which ends control and interrupts the
//! sessions that had it.
//!
//! The pure parts (status parsing, what to do on a change, hotkey text) are unit-tested here;
//! the Tauri wiring lives in `install`.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

pub const POLL: Duration = Duration::from_millis(500);
pub const INDICATOR: &str = "indicator";
pub const TRAY_STOP: &str = "computer_stop";
pub const TRAY_OPEN: &str = "open_panel";
/// Ctrl+Alt+Esc everywhere (Ctrl+Option+Esc on macOS: Cmd+Option+Esc is the system's Force Quit).
pub const HOTKEY_LABEL: &str = "Ctrl+Alt+Esc";

/// What the agent said on the last poll.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct View {
    pub enabled: bool,
    /// Labels of the sessions holding control.
    pub active: Vec<String>,
}

pub fn parse_status(v: &Value) -> View {
    let active = v
        .get("active")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| s.get("label").and_then(Value::as_str))
                .map(|s| s.chars().take(60).collect())
                .collect()
        })
        .unwrap_or_default();
    View { enabled: v.get("enabled").and_then(Value::as_bool).unwrap_or(false), active }
}

/// What the poll thread changes after a poll.
#[derive(Debug, PartialEq, Eq)]
pub struct Changes {
    pub show_indicator: bool,
    pub stop_enabled: bool,
    /// Some(true) register the hotkey, Some(false) unregister it, None leave it.
    pub hotkey: Option<bool>,
}

/// The hotkey is held only while computer control is enabled, so it doesn't steal Ctrl+Alt+Esc
/// from other apps the rest of the time. An unreachable agent reads as "nobody has control".
pub fn changes(prev: &View, next: &View) -> Changes {
    Changes {
        show_indicator: !next.active.is_empty(),
        stop_enabled: !next.active.is_empty(),
        hotkey: (prev.enabled != next.enabled).then_some(next.enabled),
    }
}

pub fn status_params(indicator_shown: bool) -> Value {
    json!({ "indicatorShown": indicator_shown })
}

pub fn kill_params(via: &str) -> Value {
    json!({ "via": via })
}

/// Shared between the poll thread, the hotkey handler, the tray and the indicator page.
#[derive(Default)]
pub struct ComputerUi {
    pub shown: AtomicBool,
    pub view: Mutex<View>,
}

pub type SharedUi = Arc<ComputerUi>;

#[cfg(target_os = "macos")]
mod mac {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> bool;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGPreflightScreenCaptureAccess() -> bool;
    }
}

/// macOS privacy permissions computer control needs, as this app sees them (its sidecar agent
/// inherits them: the app is the responsible process). None elsewhere: nothing to grant.
#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub platform: &'static str,
    pub screen_recording: Option<bool>,
    pub accessibility: Option<bool>,
    /// Linux under Wayland: computer control can't run (the agent refuses with the same reason).
    pub wayland: bool,
}

pub fn permissions() -> Permissions {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: both are argument-less queries with no side effects.
        let (screen, ax) = unsafe { (mac::CGPreflightScreenCaptureAccess(), mac::AXIsProcessTrusted()) };
        Permissions { platform: "macos", screen_recording: Some(screen), accessibility: Some(ax), wayland: false }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let wayland = cfg!(target_os = "linux")
            && (std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland")
                || (std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("DISPLAY").is_none()));
        Permissions {
            platform: if cfg!(windows) { "windows" } else { "linux" },
            screen_recording: None,
            accessibility: None,
            wayland,
        }
    }
}

/// The System Settings pane for a permission (macOS only; fixed URLs, nothing from the webview).
pub fn settings_url(pane: &str) -> Option<&'static str> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    match pane {
        "screenRecording" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"),
        "accessibility" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_agents_status() {
        let v = json!({ "enabled": true, "active": [{ "sid": "s1", "label": "chalito", "since": 1 }], "pending": [] });
        assert_eq!(parse_status(&v), View { enabled: true, active: vec!["chalito".into()] });
        assert_eq!(parse_status(&json!(null)), View::default());
    }

    #[test]
    fn indicator_and_tray_follow_active_sessions_and_the_hotkey_follows_enabled() {
        let off = View::default();
        let on = View { enabled: true, active: vec![] };
        let active = View { enabled: true, active: vec!["a".into()] };
        assert_eq!(changes(&off, &on), Changes { show_indicator: false, stop_enabled: false, hotkey: Some(true) });
        assert_eq!(changes(&on, &active), Changes { show_indicator: true, stop_enabled: true, hotkey: None });
        assert_eq!(changes(&active, &off), Changes { show_indicator: false, stop_enabled: false, hotkey: Some(false) });
    }

    #[test]
    fn params_and_settings_urls() {
        assert_eq!(status_params(true), json!({ "indicatorShown": true }));
        assert_eq!(kill_params("hotkey"), json!({ "via": "hotkey" }));
        assert_eq!(settings_url("nope"), None);
        if !cfg!(target_os = "macos") {
            assert_eq!(settings_url("accessibility"), None);
        }
    }
}
