//! Start with the computer (First Run C, ADR 0028): leave the PC on and Chalito comes back in the
//! tray after a restart, with its agent, and nothing to type. On by default (owner decision
//! 2026-10-16): the first launch turns it on; after that the person's choice (the panel's switch or
//! the tray's check item) is kept in `autostart.json` and never overridden.
//!
//! The OS entry is tauri-plugin-autostart's on macOS and Windows; on Linux `xdg` writes it, as the
//! plugin ignores XDG_CONFIG_HOME and points the entry at whichever AppImage copy ran last.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Launch {
    /// First launch: turn it on.
    Enable,
    /// On by choice: fix the OS entry only if it points at a copy that is gone (Linux).
    Repair,
    /// Off by choice: leave the OS alone.
    Nothing,
}

/// What to do at launch: the first time, turn it on; after that, never re-create or move the OS
/// entry (the person may also have turned it off in the OS's own settings).
pub fn on_launch(saved: Option<Pref>) -> Launch {
    match saved {
        None => Launch::Enable,
        Some(Pref { enabled: true }) => Launch::Repair,
        Some(Pref { enabled: false }) => Launch::Nothing,
    }
}

/// The program the Linux entry starts: the AppImage file when this binary runs from its mount
/// (`APPDIR`; children of other AppImages inherit `APPIMAGE`), else the installed binary.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn launch_target(appimage: Option<OsString>, appdir: Option<OsString>, exe: PathBuf) -> PathBuf {
    let set = |v: Option<OsString>| v.filter(|v| !v.is_empty()).map(PathBuf::from);
    match (set(appimage), set(appdir)) {
        (Some(image), Some(mount)) if exe.starts_with(&mount) => image,
        _ => exe,
    }
}

/// The XDG autostart entry (Linux). Pure file work, so tests run it against temp dirs.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub mod xdg {
    use super::*;
    use std::ffi::OsStr;

    /// Same name the plugin used (the product name), so entries from earlier builds are found.
    pub const ENTRY: &str = "Chalito.desktop";

    /// `$XDG_CONFIG_HOME/autostart`, or `~/.config/autostart` when it's unset, empty or relative
    /// (the XDG base-dir spec says to ignore a relative value).
    pub fn dir(home: &Path, xdg_config_home: Option<&OsStr>) -> PathBuf {
        let base = xdg_config_home
            .map(Path::new)
            .filter(|p| p.is_absolute())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join(".config"));
        base.join("autostart")
    }

    /// Where tauri-plugin-autostart wrote the entry, whatever XDG_CONFIG_HOME said.
    pub fn legacy_dir(home: &Path) -> PathBuf {
        home.join(".config").join("autostart")
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub enum State {
        Missing,
        /// Kept but switched off in the desktop's own settings (`Hidden=true`, `X-…-Autostart-enabled=false`).
        Off,
        /// Starts a program that exists and can run.
        Live,
        /// Names a copy that is gone, not executable, or can't be read.
        Dangling,
    }

    /// A regular file with an execute bit: what the session can actually start.
    pub fn runnable(p: &Path) -> bool {
        let Ok(m) = fs::metadata(p) else { return false };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            m.is_file() && m.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        {
            m.is_file()
        }
    }

    /// `key=value` pairs of the `[Desktop Entry]` group (other groups, like actions, ignored).
    pub fn main_group(entry: &str) -> impl Iterator<Item = (&str, &str)> {
        let mut in_main = false;
        entry.lines().filter_map(move |l| {
            let l = l.trim();
            if l.starts_with('[') {
                in_main = l == "[Desktop Entry]";
                return None;
            }
            let (k, v) = l.split_once('=')?;
            in_main.then(|| (k.trim(), v.trim()))
        })
    }

    /// The program in an entry's `Exec` line, quoted (ours) or bare (the plugin's).
    pub fn exec_target(entry: &str) -> Option<PathBuf> {
        let raw = main_group(entry).find_map(|(k, v)| (k == "Exec").then_some(v))?;
        // Desktop-entry string escapes first, then Exec quoting (Desktop Entry spec, "Exec key").
        let value = raw.replace("\\\\", "\\");
        if let Some(rest) = value.strip_prefix('"') {
            let mut out = String::new();
            let mut chars = rest.chars();
            while let Some(c) = chars.next() {
                match c {
                    '\\' => out.push(chars.next()?),
                    '"' => return Some(PathBuf::from(out.replace("%%", "%"))),
                    c => out.push(c),
                }
            }
            None
        } else {
            let prog = value.split_whitespace().next()?;
            Some(PathBuf::from(prog.replace("%%", "%")))
        }
    }

    pub fn state(dir: &Path) -> io::Result<State> {
        let bytes = match fs::read(dir.join(ENTRY)) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(State::Missing),
            r => r?,
        };
        let entry = String::from_utf8_lossy(&bytes);
        let off = main_group(&entry)
            .any(|(k, v)| (k == "Hidden" && v == "true") || (k.ends_with("-Autostart-enabled") && v == "false"));
        if off {
            return Ok(State::Off);
        }
        // A bare name (`chalito`, `env`) is someone's own edit resolved through PATH: left alone.
        let live = |t: &Path| t.is_relative() || runnable(t);
        // The plugin wrote paths unquoted, so `/home/ana/My Apps/…` is one path, not a command.
        let unquoted = main_group(&entry).find_map(|(k, v)| (k == "Exec").then(|| PathBuf::from(v)));
        Ok(match exec_target(&entry) {
            Some(t) if live(&t) => State::Live,
            _ if unquoted.is_some_and(|u| u.is_absolute() && runnable(&u)) => State::Live,
            _ => State::Dangling,
        })
    }

    pub fn is_enabled(dir: &Path) -> io::Result<bool> {
        Ok(matches!(state(dir)?, State::Live | State::Dangling))
    }

    /// `target` quoted for an `Exec` line, escapes and all (also used for the chalito:// handler).
    pub fn exec_value(target: &Path) -> io::Result<String> {
        let t = target.to_str().ok_or_else(|| io::Error::other("path is not UTF-8"))?;
        if t.contains(['\n', '\r']) {
            return Err(io::Error::other("path has a line break"));
        }
        let mut q = String::new();
        for c in t.chars() {
            if matches!(c, '"' | '`' | '$' | '\\') {
                q.push('\\');
            }
            q.push(c);
        }
        Ok(format!("\"{}\"", q.replace('%', "%%")).replace('\\', "\\\\"))
    }

    fn entry_for(target: &Path) -> io::Result<String> {
        let exec = exec_value(target)?;
        Ok(format!(
            "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Chalito\nComment=Chalito startup script\nExec={exec}\nStartupNotify=false\nTerminal=false\n"
        ))
    }

    fn put(dir: &Path, body: &[u8]) -> io::Result<()> {
        fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(".{ENTRY}.{}.tmp", std::process::id()));
        fs::write(&tmp, body)?;
        fs::rename(tmp, dir.join(ENTRY))
    }

    /// Points the entry at `target` whatever it held (the panel's "Usar esta copia").
    pub fn write(dir: &Path, target: &Path) -> io::Result<()> {
        put(dir, entry_for(target)?.as_bytes())
    }

    /// Turns it on. An entry that already starts a working copy is kept as is, so opening a second
    /// copy (say, one in ~/Downloads) never moves autostart onto it.
    pub fn enable(dir: &Path, target: &Path) -> io::Result<()> {
        if state(dir)? == State::Live {
            return Ok(());
        }
        write(dir, target)
    }

    /// Launch, choice on: adopts the plugin's ~/.config entry when XDG_CONFIG_HOME differs, then
    /// repoints an entry whose copy is gone. Never creates one or touches one switched off.
    pub fn repair(dir: &Path, legacy: &Path, target: &Path) -> io::Result<bool> {
        let mut wrote = false;
        if dir != legacy && state(dir)? == State::Missing && state(legacy)? != State::Missing {
            // Copy then delete, not rename: the two folders may be on different filesystems.
            put(dir, &fs::read(legacy.join(ENTRY))?)?;
            fs::remove_file(legacy.join(ENTRY))?;
            wrote = true;
        }
        if state(dir)? == State::Dangling {
            write(dir, target)?;
            wrote = true;
        }
        Ok(wrote)
    }

    /// Turns it off, here and in the plugin's old folder.
    pub fn disable(dir: &Path, legacy: &Path) -> io::Result<()> {
        for d in [dir, legacy] {
            match fs::remove_file(d.join(ENTRY)) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
        Ok(())
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
        assert_eq!(on_launch(None), Launch::Enable);
        assert_eq!(on_launch(Some(Pref { enabled: true })), Launch::Repair);
        assert_eq!(on_launch(Some(Pref { enabled: false })), Launch::Nothing);
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
        assert_eq!(on_launch(read(&d)), Launch::Nothing);
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

    /// An executable stand-in for a copy of the app.
    fn copy_at(p: &Path) -> PathBuf {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        p.to_path_buf()
    }

    fn exec_of(dir: &Path) -> PathBuf {
        xdg::exec_target(&fs::read_to_string(dir.join(xdg::ENTRY)).unwrap()).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn xdg_dir_follows_xdg_config_home() {
        let home = Path::new("/home/ana");
        assert_eq!(xdg::dir(home, None), home.join(".config/autostart"));
        assert_eq!(xdg::dir(home, Some("/x/cfg".as_ref())), Path::new("/x/cfg/autostart"));
        // Empty or relative: ignored, as the XDG base-dir spec says.
        assert_eq!(xdg::dir(home, Some("".as_ref())), home.join(".config/autostart"));
        assert_eq!(xdg::dir(home, Some("cfg".as_ref())), home.join(".config/autostart"));
    }

    #[cfg(unix)]
    #[test]
    fn a_second_copy_does_not_take_over_a_working_entry() {
        let d = tmp("two-copies");
        let dir = xdg::dir(&d.join("home"), Some(d.join("cfg").as_os_str()));
        let installed = copy_at(&d.join("home/Applications/Chalito.AppImage"));
        let downloaded = copy_at(&d.join("home/Downloads/Chalito.AppImage"));
        xdg::enable(&dir, &installed).unwrap();
        assert_eq!(exec_of(&dir), installed);
        assert!(dir.starts_with(d.join("cfg")));
        assert!(!d.join("home/.config/autostart").exists());
        xdg::enable(&dir, &downloaded).unwrap();
        assert!(!xdg::repair(&dir, &xdg::legacy_dir(&d.join("home")), &downloaded).unwrap());
        assert_eq!(exec_of(&dir), installed);
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn an_entry_for_a_deleted_copy_moves_to_the_one_running() {
        let d = tmp("deleted");
        let dir = xdg::dir(&d.join("home"), None);
        let old = copy_at(&d.join("home/Downloads/Chalito.AppImage"));
        let new = copy_at(&d.join("home/Applications/Chalito.AppImage"));
        xdg::enable(&dir, &old).unwrap();
        fs::remove_file(&old).unwrap();
        assert!(xdg::repair(&dir, &xdg::legacy_dir(&d.join("home")), &new).unwrap());
        assert_eq!(exec_of(&dir), new);
        // Same through the switch: turning it on again fixes a dangling entry too.
        fs::remove_file(&new).unwrap();
        let third = copy_at(&d.join("home/bin/Chalito.AppImage"));
        xdg::enable(&dir, &third).unwrap();
        assert_eq!(exec_of(&dir), third);
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn a_target_that_is_not_executable_counts_as_gone() {
        let d = tmp("noexec");
        let dir = xdg::dir(&d.join("home"), None);
        let old = d.join("home/Downloads/Chalito.AppImage");
        fs::create_dir_all(old.parent().unwrap()).unwrap();
        fs::write(&old, b"").unwrap(); // a fresh download before `chmod +x`
        let new = copy_at(&d.join("home/Applications/Chalito.AppImage"));
        fs::create_dir_all(&dir).unwrap();
        let entry = format!("[Desktop Entry]\nExec={} \n", old.display());
        fs::write(dir.join(xdg::ENTRY), entry).unwrap();
        assert!(xdg::repair(&dir, &xdg::legacy_dir(&d.join("home")), &new).unwrap());
        assert_eq!(exec_of(&dir), new);
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn off_stays_off() {
        let d = tmp("off");
        let dir = xdg::dir(&d.join("home"), Some(d.join("cfg").as_os_str()));
        let copy = copy_at(&d.join("home/Chalito.AppImage"));
        xdg::enable(&dir, &copy).unwrap();
        xdg::disable(&dir, &xdg::legacy_dir(&d.join("home"))).unwrap();
        assert!(!xdg::is_enabled(&dir).unwrap());
        // Already off: fine.
        xdg::disable(&dir, &xdg::legacy_dir(&d.join("home"))).unwrap();
        // Repair never creates an entry the person (or the OS settings) removed.
        assert!(!xdg::repair(&dir, &xdg::legacy_dir(&d.join("home")), &copy).unwrap());
        assert!(!xdg::is_enabled(&dir).unwrap());
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn a_plugin_written_entry_is_read_and_kept() {
        let d = tmp("plugin");
        let dir = xdg::dir(&d.join("home"), None);
        let usr_bin = copy_at(&d.join("usr/bin/chalito-desktop"));
        let other = copy_at(&d.join("home/Downloads/Chalito.AppImage"));
        fs::create_dir_all(&dir).unwrap();
        // tauri-plugin-autostart 2.7's format: bare path, a trailing space, no final newline.
        let plugin = format!(
            "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Chalito\nComment=Chalito startup script\nExec={} \nStartupNotify=false\nTerminal=false",
            usr_bin.display()
        );
        fs::write(dir.join(xdg::ENTRY), &plugin).unwrap();
        xdg::enable(&dir, &other).unwrap();
        assert_eq!(fs::read_to_string(dir.join(xdg::ENTRY)).unwrap(), plugin);
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn a_hand_edited_entry_with_a_bare_command_is_left_alone() {
        let d = tmp("bare");
        let dir = xdg::dir(&d.join("home"), None);
        let copy = copy_at(&d.join("home/Downloads/Chalito.AppImage"));
        fs::create_dir_all(&dir).unwrap();
        let mine = "[Desktop Entry]\nExec=env GDK_SCALE=2 chalito-desktop\n";
        fs::write(dir.join(xdg::ENTRY), mine).unwrap();
        xdg::enable(&dir, &copy).unwrap();
        assert!(!xdg::repair(&dir, &xdg::legacy_dir(&d.join("home")), &copy).unwrap());
        assert_eq!(fs::read_to_string(dir.join(xdg::ENTRY)).unwrap(), mine);
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn odd_paths_round_trip_through_exec() {
        let d = tmp("odd");
        let dir = xdg::dir(&d.join("home"), None);
        let copy = copy_at(&d.join("home/My Apps/Cha\"li$to `100%`\\x.AppImage"));
        xdg::enable(&dir, &copy).unwrap();
        assert_eq!(exec_of(&dir), copy);
        assert!(xdg::runnable(&exec_of(&dir)));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn deb_and_rpm_register_the_installed_binary() {
        let exe = PathBuf::from("/usr/bin/chalito-desktop");
        assert_eq!(launch_target(None, None, exe.clone()), exe);
        assert_eq!(launch_target(Some("".into()), Some("".into()), exe.clone()), exe);
    }

    #[test]
    fn an_appimage_registers_the_image_file_not_its_mount() {
        let exe = PathBuf::from("/tmp/.mount_ChalAb12/usr/bin/chalito-desktop");
        let image = PathBuf::from("/home/ana/Chalito.AppImage");
        let got = launch_target(Some(image.clone().into()), Some("/tmp/.mount_ChalAb12".into()), exe);
        assert_eq!(got, image);
    }

    #[test]
    fn an_appimage_variable_inherited_from_another_app_is_ignored() {
        // The deb build started from a terminal inside Cursor's AppImage.
        let exe = PathBuf::from("/usr/bin/chalito-desktop");
        let got = launch_target(
            Some("/home/ana/Apps/Cursor.AppImage".into()),
            Some("/tmp/.mount_CursorX1".into()),
            exe.clone(),
        );
        assert_eq!(got, exe);
        assert_eq!(
            launch_target(Some("/home/ana/Apps/Cursor.AppImage".into()), None, exe.clone()),
            exe
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_entry_switched_off_in_the_desktop_stays_off_until_the_switch() {
        for flag in [
            "Hidden=true",
            "X-GNOME-Autostart-enabled=false",
            "X-MATE-Autostart-enabled = false",
        ] {
            let d = tmp("hidden");
            let dir = xdg::dir(&d.join("home"), None);
            let legacy = xdg::legacy_dir(&d.join("home"));
            let copy = copy_at(&d.join("home/Applications/Chalito.AppImage"));
            fs::create_dir_all(&dir).unwrap();
            // Its copy is gone too: repair still must not bring it back.
            let entry = format!("[Desktop Entry]\nExec=/gone/Chalito.AppImage\n{flag}\n");
            fs::write(dir.join(xdg::ENTRY), &entry).unwrap();
            assert!(!xdg::is_enabled(&dir).unwrap(), "{flag}");
            assert!(!xdg::repair(&dir, &legacy, &copy).unwrap());
            assert_eq!(fs::read_to_string(dir.join(xdg::ENTRY)).unwrap(), entry);
            // Turning it on from the panel or tray writes a fresh, enabled entry.
            xdg::enable(&dir, &copy).unwrap();
            assert!(xdg::is_enabled(&dir).unwrap());
            assert_eq!(exec_of(&dir), copy);
            let _ = fs::remove_dir_all(&d);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_plugin_entry_for_an_old_appimage_mount_is_repointed() {
        let d = tmp("plugin-mount");
        let dir = xdg::dir(&d.join("home"), None);
        let image = copy_at(&d.join("home/Applications/Chalito.AppImage"));
        fs::create_dir_all(&dir).unwrap();
        let plugin = "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Chalito\nComment=Chalito startup script\nExec=/tmp/.mount_ChalGone/usr/bin/chalito-desktop \nStartupNotify=false\nTerminal=false";
        fs::write(dir.join(xdg::ENTRY), plugin).unwrap();
        assert!(xdg::is_enabled(&dir).unwrap());
        assert!(xdg::repair(&dir, &xdg::legacy_dir(&d.join("home")), &image).unwrap());
        assert_eq!(exec_of(&dir), image);
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn the_plugins_entry_in_dot_config_moves_under_xdg_config_home() {
        let d = tmp("legacy");
        let home = d.join("home");
        let dir = xdg::dir(&home, Some(d.join("cfg").as_os_str()));
        let legacy = xdg::legacy_dir(&home);
        let image = copy_at(&home.join("Applications/Chalito.AppImage"));
        fs::create_dir_all(&legacy).unwrap();
        fs::write(
            legacy.join(xdg::ENTRY),
            format!("[Desktop Entry]\nExec={} ", image.display()),
        )
        .unwrap();
        assert!(!xdg::is_enabled(&dir).unwrap());
        assert!(xdg::repair(&dir, &legacy, &image).unwrap());
        assert!(xdg::is_enabled(&dir).unwrap());
        assert_eq!(exec_of(&dir), image);
        assert!(!legacy.join(xdg::ENTRY).exists());
        // Turning it off clears both folders.
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join(xdg::ENTRY), "[Desktop Entry]\nExec=/x\n").unwrap();
        xdg::disable(&dir, &legacy).unwrap();
        assert!(!dir.join(xdg::ENTRY).exists() && !legacy.join(xdg::ENTRY).exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn an_entry_that_cannot_be_read_is_an_error_not_an_overwrite() {
        let d = tmp("unreadable");
        let dir = xdg::dir(&d.join("home"), None);
        let copy = copy_at(&d.join("home/Chalito.AppImage"));
        // A folder where the entry should be: reading it fails with something other than NotFound.
        fs::create_dir_all(dir.join(xdg::ENTRY)).unwrap();
        assert!(xdg::enable(&dir, &copy).is_err());
        assert!(xdg::repair(&dir, &xdg::legacy_dir(&d.join("home")), &copy).is_err());
        assert!(dir.join(xdg::ENTRY).is_dir());
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn a_plugin_entry_with_spaces_in_its_path_counts_as_working() {
        let d = tmp("plugin-spaces");
        let dir = xdg::dir(&d.join("home"), None);
        let installed = copy_at(&d.join("home/My Apps/Chalito.AppImage"));
        let downloaded = copy_at(&d.join("home/Downloads/Chalito.AppImage"));
        fs::create_dir_all(&dir).unwrap();
        let plugin = format!("[Desktop Entry]\nExec={} \nTerminal=false", installed.display());
        fs::write(dir.join(xdg::ENTRY), &plugin).unwrap();
        assert_eq!(xdg::state(&dir).unwrap(), xdg::State::Live);
        xdg::enable(&dir, &downloaded).unwrap();
        assert!(!xdg::repair(&dir, &xdg::legacy_dir(&d.join("home")), &downloaded).unwrap());
        assert_eq!(fs::read_to_string(dir.join(xdg::ENTRY)).unwrap(), plugin);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn exec_is_read_from_the_main_group_only() {
        let e = "[Desktop Entry]\nName=Chalito\nExec = /opt/chalito/run --x\n[Desktop Action New]\nExec=/other\n";
        assert_eq!(xdg::exec_target(e), Some(PathBuf::from("/opt/chalito/run")));
        assert_eq!(xdg::exec_target("[Desktop Action A]\nExec=/other\n"), None);
        assert_eq!(xdg::exec_target("[Desktop Entry]\nExec=\"/unclosed\n"), None);
    }

    #[test]
    fn tray_label_follows_the_language() {
        assert_eq!(tray_label("en-US"), "Start with the computer");
        assert_eq!(tray_label("es-MX"), "Iniciar con la computadora");
        assert_eq!(tray_label(""), "Iniciar con la computadora");
    }
}
