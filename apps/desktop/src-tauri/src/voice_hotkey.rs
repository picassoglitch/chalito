//! Push-to-talk for offline voice commands: one global shortcut, held only while the person has the
//! mode on. Press and release go to the panel, which owns the mic; nothing listens otherwise.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const PTT_EVENT: &str = "chalito://voice-ptt";

#[derive(Default)]
pub struct VoiceHotkey(Mutex<Option<Shortcut>>);

/// The same grammar the panel checks (`validHotkey` in settings.ts): modifiers, then one plain key.
const MODIFIERS: &[&str] = &["commandorcontrol", "cmdorctrl", "control", "ctrl", "alt", "option", "shift", "super", "command", "cmd"];
const KEYS: &[&str] = &[
    "space", "period", "comma", "slash", "semicolon", "quote", "backquote", "minus", "equal", "enter", "tab",
];

/// Combos the OS or every app already uses (both Control and Super, for CommandOrControl).
const SYSTEM: &[&str] = &[
    "Super+Space", "Control+Space", "Alt+Space", "Alt+Tab", "Super+Tab", "Control+Tab", "Alt+F4",
    "Super+Q", "Super+W", "Super+L", "Super+D", "Super+H", "Super+M", "Control+Q", "Control+W",
    "Control+C", "Control+V", "Control+X", "Control+Z", "Control+A", "Control+S",
    "Super+C", "Super+V", "Super+X", "Super+Z", "Super+A", "Super+S",
];

fn plain_key(k: &str) -> bool {
    let k = k.to_ascii_lowercase();
    let f = k.strip_prefix('f').and_then(|n| n.parse::<u8>().ok());
    (k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()))
        || matches!(f, Some(1..=12))
        || KEYS.contains(&k.as_str())
}

/// Needs a modifier (a bare key would be taken from every other app), and can't be a system combo
/// or one Chalito already holds.
pub fn parse(accel: &str, reserved: &[Shortcut]) -> Result<Shortcut, String> {
    let parts: Vec<String> = accel.split('+').map(|p| p.trim().to_ascii_lowercase()).collect();
    let (key, mods) = parts.split_last().ok_or("empty shortcut")?;
    if mods.is_empty() || !mods.iter().all(|m| MODIFIERS.contains(&m.as_str())) || !plain_key(key) {
        return Err("use one or more modifier keys and one plain key".into());
    }
    let s: Shortcut = accel.trim().parse().map_err(|e| format!("{e}"))?;
    let same = |r: &Shortcut| r.mods == s.mods && r.key == s.key;
    if reserved.iter().any(same) {
        return Err("that shortcut is already used by Chalito".into());
    }
    if SYSTEM.iter().filter_map(|c| c.parse::<Shortcut>().ok()).any(|r| same(&r)) {
        return Err("your system or other apps already use that shortcut".into());
    }
    Ok(s)
}

/// Only the panel turns the hotkey on or off, like the other panel commands.
pub fn may_set(window_label: &str) -> Result<(), String> {
    if window_label == "panel" {
        Ok(())
    } else {
        Err("unavailable".into())
    }
}

/// What to tell the panel when a shortcut fires, if it's the voice one.
pub fn ptt_payload(current: Option<&Shortcut>, fired: &Shortcut, state: ShortcutState) -> Option<&'static str> {
    let c = current?;
    if c.mods != fired.mods || c.key != fired.key {
        return None;
    }
    Some(if state == ShortcutState::Pressed { "down" } else { "up" })
}

/// Called from the plugin's one handler for every shortcut.
pub fn on_shortcut(app: &AppHandle, hotkey: &VoiceHotkey, fired: &Shortcut, state: ShortcutState) {
    let current = match hotkey.0.lock() {
        Ok(g) => *g,
        Err(_) => return eprintln!("offline voice: hotkey lock poisoned"),
    };
    if let Some(p) = ptt_payload(current.as_ref(), fired, state) {
        if let Err(e) = app.emit_to("panel", PTT_EVENT, p) {
            eprintln!("offline voice: ptt {p}: {e}");
        }
    }
}

/// Swaps the held shortcut for `accel`, or releases it with None. Sync commands run on the main
/// thread, where macOS needs (un)registration to happen.
pub fn set(app: &AppHandle, hotkey: &VoiceHotkey, accel: Option<&str>, reserved: &[Shortcut]) -> Result<(), String> {
    let next = accel.map(|a| parse(a, reserved)).transpose()?;
    let mut held = hotkey.0.lock().map_err(|_| "voice hotkey lock poisoned".to_string())?;
    let gs = app.global_shortcut();
    *held = swap(*held, next, |s| gs.register(s).map_err(|e| e.to_string()), |s| {
        gs.unregister(s).map_err(|e| e.to_string())
    })?;
    Ok(())
}

/// What the held shortcut becomes. The new one is registered first, so if the OS refuses it the
/// person keeps the hotkey that worked; a failed release of the old one is only logged.
pub fn swap(
    held: Option<Shortcut>,
    next: Option<Shortcut>,
    register: impl FnOnce(Shortcut) -> Result<(), String>,
    unregister: impl FnOnce(Shortcut) -> Result<(), String>,
) -> Result<Option<Shortcut>, String> {
    if held == next {
        return Ok(held);
    }
    if let Some(s) = next {
        register(s)?;
    }
    if let Some(old) = held {
        if let Err(e) = unregister(old) {
            eprintln!("offline voice: hotkey unregister: {e}");
        }
    }
    Ok(next)
}

#[tauri::command]
pub fn set_voice_hotkey(
    app: AppHandle,
    window: tauri::Window,
    hotkey: State<'_, VoiceHotkey>,
    accel: Option<String>,
) -> Result<(), String> {
    may_set(window.label())?;
    set(&app, &hotkey, accel.as_deref(), &[crate::kill_hotkey()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_global_shortcut::{Code, Modifiers};

    #[test]
    fn parses_the_default_and_refuses_bare_or_reserved_keys() {
        let s = parse("CommandOrControl+Shift+Space", &[]).unwrap();
        assert_eq!(s.key, Code::Space);
        assert!(s.mods.contains(Modifiers::SHIFT));
        assert!(parse("Space", &[]).is_err());
        assert!(parse("Ctrl+Shift+NotAKey", &[]).is_err());
        let kill = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Escape);
        assert!(parse("Control+Alt+Escape", &[kill]).is_err());
    }

    #[test]
    fn only_the_panel_window_may_set_it() {
        assert!(may_set("panel").is_ok());
        for w in ["pet", "room", "indicator", ""] {
            assert!(may_set(w).is_err(), "{w}");
        }
    }

    #[test]
    fn refuses_keys_outside_the_panel_grammar() {
        for bad in ["Ctrl+Escape", "Ctrl+Shift+Banana", "Shift", "Ctrl+", "+V", "Hyper+V", "Ctrl+F13", "Ctrl+ArrowUp"] {
            assert!(parse(bad, &[]).is_err(), "{bad}");
        }
        for good in ["CommandOrControl+Shift+Space", "Alt+F9", "Ctrl+Alt+7", "Shift+Alt+Period"] {
            assert!(parse(good, &[]).is_ok(), "{good}");
        }
    }

    #[test]
    fn refuses_system_combos() {
        for sys in ["CommandOrControl+Space", "Alt+Tab", "Super+L", "Control+C", "Cmd+Q", "Alt+F4", "Super+Space"] {
            assert!(parse(sys, &[]).is_err(), "{sys}");
        }
    }

    #[test]
    fn swap_registers_new_before_old_and_keeps_the_old_one_if_refused() {
        use std::cell::RefCell;
        let a = parse("Alt+Shift+V", &[]).unwrap();
        let b = parse("Alt+Shift+B", &[]).unwrap();
        let log = RefCell::new(Vec::<String>::new());
        let reg = |s: Shortcut| {
            log.borrow_mut().push(format!("reg {:?}", s.key));
            Ok(())
        };
        let unreg = |s: Shortcut| {
            log.borrow_mut().push(format!("unreg {:?}", s.key));
            Ok(())
        };
        // Unchanged: no OS calls.
        assert_eq!(swap(Some(a), Some(a), reg, unreg), Ok(Some(a)));
        assert!(log.borrow().is_empty());
        // Swap: new first, then old.
        assert_eq!(swap(Some(a), Some(b), reg, unreg), Ok(Some(b)));
        assert_eq!(*log.borrow(), vec!["reg KeyB".to_string(), "unreg KeyV".to_string()]);
        // Refused: error, and the old one is never released.
        log.borrow_mut().clear();
        let refuse = |_: Shortcut| Err("taken".to_string());
        assert_eq!(swap(Some(a), Some(b), refuse, unreg), Err("taken".to_string()));
        assert!(log.borrow().is_empty());
        // Off: only a release.
        assert_eq!(swap(Some(a), None, reg, unreg), Ok(None));
        assert_eq!(*log.borrow(), vec!["unreg KeyV".to_string()]);
    }

    #[test]
    fn only_the_voice_shortcut_reaches_the_panel() {
        let voice = parse("Alt+Shift+V", &[]).unwrap();
        let other = parse("Alt+Shift+K", &[]).unwrap();
        assert_eq!(ptt_payload(Some(&voice), &voice, ShortcutState::Pressed), Some("down"));
        assert_eq!(ptt_payload(Some(&voice), &voice, ShortcutState::Released), Some("up"));
        assert_eq!(ptt_payload(Some(&voice), &other, ShortcutState::Pressed), None);
        assert_eq!(ptt_payload(None, &voice, ShortcutState::Pressed), None);
    }
}
