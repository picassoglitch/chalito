//! Start with the computer (First Run C, ADR 0028): leave the PC on and Chalito comes back in the
//! tray after a restart, with its agent, and nothing to type. On by default (owner decision
//! 2026-10-16): the first launch turns it on; after that the person's choice (the panel's switch or
//! the tray's check item) is kept in `autostart.json` and never overridden.
//!
//! The OS entry itself is tauri-plugin-autostart's (a LaunchAgent on macOS, an XDG autostart
//! file on Linux, the Run key on Windows); this file only decides when to write it.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const FILE: &str = "autostart.json";

/// The tray's check item id.
pub const TRAY_ITEM: &str = "autostart";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Pref {
    pub enabled: bool,
}

/// The person's saved choice, or None before the first launch (or when the file is unreadable).
pub fn read(dir: &Path) -> Option<Pref> {
    let raw = fs::read_to_string(dir.join(FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write(dir: &Path, pref: Pref) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    fs::write(&tmp, serde_json::to_vec(&pref).map_err(io::Error::other)?)?;
    fs::rename(tmp, dir.join(FILE))
}

/// What to do at launch: the first time, turn it on; after that, leave the OS entry alone (the
/// person may also have turned it off in the OS's own settings).
pub fn on_launch(saved: Option<Pref>) -> Option<bool> {
    match saved {
        None => Some(true),
        Some(_) => None,
    }
}

/// Tray label, in the app's two languages (the OS locale decides; Spanish by default).
pub fn tray_label(lang: &str) -> &'static str {
    if lang.to_ascii_lowercase().starts_with("en") {
        "Start with the computer"
    } else {
        "Iniciar con la computadora"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("chalito-autostart-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn first_launch_turns_it_on_then_the_choice_stands() {
        assert_eq!(on_launch(None), Some(true));
        assert_eq!(on_launch(Some(Pref { enabled: true })), None);
        assert_eq!(on_launch(Some(Pref { enabled: false })), None);
    }

    #[test]
    fn the_choice_persists_across_launches() {
        let d = tmp("persist");
        assert_eq!(read(&d), None);
        write(&d, Pref { enabled: true }).unwrap();
        assert_eq!(read(&d), Some(Pref { enabled: true }));
        // Turned off from the panel or the tray: the next launch must not turn it back on.
        write(&d, Pref { enabled: false }).unwrap();
        assert_eq!(read(&d), Some(Pref { enabled: false }));
        assert_eq!(on_launch(read(&d)), None);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_corrupt_file_counts_as_no_choice_yet() {
        let d = tmp("corrupt");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(FILE), b"{not json").unwrap();
        assert_eq!(read(&d), None);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn tray_label_follows_the_language() {
        assert_eq!(tray_label("en-US"), "Start with the computer");
        assert_eq!(tray_label("es-MX"), "Iniciar con la computadora");
        assert_eq!(tray_label(""), "Iniciar con la computadora");
    }
}
