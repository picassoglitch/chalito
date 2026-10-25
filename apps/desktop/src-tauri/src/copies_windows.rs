//! Windows side of copies.rs: NSIS installs in the uninstall registry, downloaded installers, and
//! where the Run value and the chalito:// handler point. Fixes run only on the person's click.
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::{Path, PathBuf};

use crate::copies::{self, CopyKind, Install, Link, OldCopy, Refusal, Report, Scope};

/// Where the NSIS installer writes `Uninstall\Chalito` (HKCU per user, HKLM per machine).
pub const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
/// tauri-plugin-autostart (auto-launch): `Run\<productName>`, in HKLM when it may, else HKCU.
pub const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// Task Manager's on/off switch for each Run value.
pub const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
pub const RUN_VALUE: &str = "Chalito";
/// Read through HKCR: the user's key (deep-link plugin) wins over the installer's HKLM one.
pub const HANDLER: &str = r"chalito\shell\open\command";

/// One uninstall entry, as the registry has it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Entry {
    /// `HKCU\<subkey>` or `HKLM\<subkey>`.
    pub id: String,
    pub scope: Option<Scope>,
    pub display: Option<String>,
    pub publisher: Option<String>,
    pub version: Option<String>,
    pub location: Option<String>,
    pub uninstall: Option<String>,
}

/// DisplayName is Chalito (the NSIS entry's is the product name; its Publisher is "chalyb").
pub fn is_chalito_entry(e: &Entry) -> bool {
    e.display.as_deref().is_some_and(|v| v.trim().eq_ignore_ascii_case("chalito"))
}

/// NSIS quotes InstallLocation (`"C:\…\Chalito"`).
pub fn unquote(s: &str) -> &str {
    let s = s.trim();
    s.strip_prefix('"').and_then(|r| r.strip_suffix('"')).unwrap_or(s)
}

/// `C:\…` or `\\server\…`: a full Windows path, whatever OS reads it.
pub fn is_abs(p: &str) -> bool {
    let b = p.as_bytes();
    (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/')) || p.starts_with(r"\\")
}

/// The program a command line starts: `"C:\a b\x.exe" "%1"`, or the bare `C:\a b\x.exe `
/// tauri-plugin-autostart writes (unquoted, spaces and all).
pub fn command_program(cmd: &str) -> Option<PathBuf> {
    let c = cmd.trim();
    if let Some(rest) = c.strip_prefix('"') {
        let p = &rest[..rest.find('"')?];
        return (!p.is_empty()).then(|| PathBuf::from(p));
    }
    let lower = c.to_ascii_lowercase();
    let exe_end = lower.match_indices(".exe").map(|(i, _)| i + 4).find(|&e| e == c.len() || c[e..].starts_with(' '));
    match exe_end {
        Some(e) => Some(PathBuf::from(&c[..e])),
        None => c.split_whitespace().next().map(PathBuf::from),
    }
}

fn norm(p: &str) -> String {
    let p = unquote(p).replace('/', "\\");
    let p = p.strip_prefix(r"\\?\").unwrap_or(&p);
    p.trim_end_matches('\\').to_lowercase()
}

/// `running` is inside the folder `location` (case-insensitive, as Windows paths are).
pub fn holds(location: &str, running: &str) -> bool {
    let (l, r) = (norm(location), norm(running));
    !l.is_empty() && r.len() > l.len() && r.starts_with(&l) && r.as_bytes()[l.len()] == b'\\'
}

/// The install's folder: InstallLocation, else where its uninstaller sits.
pub fn location_of(e: &Entry) -> Option<String> {
    let loc = e.location.as_deref().map(unquote).filter(|l| !l.is_empty()).map(String::from);
    loc.or_else(|| {
        let exe = command_program(e.uninstall.as_deref()?)?;
        let s = exe.to_string_lossy().into_owned();
        Some(s[..s.rfind(['\\', '/'])?].to_string())
    })
}

/// The running exe as given and as resolved: a short `RUNNER~1` path and its long form both count.
pub fn running_forms(running: &Path) -> Vec<String> {
    vec![running.display().to_string(), canon_str(running)]
}

fn runs_from(location: Option<&str>, running: &[String]) -> bool {
    location.is_some_and(|l| running.iter().any(|r| holds(l, r)))
}

/// Chalito installs other than the running one that "Desinstalar" may act on: the same guard
/// decides the list and the click, so no button is offered that would always be refused.
pub fn installs(entries: &[Entry], running: &[String]) -> Vec<Install> {
    entries
        .iter()
        .filter(|e| may_uninstall(&e.id, entries, running).is_ok())
        .filter_map(|e| Some(Install { id: e.id.clone(), scope: e.scope?, location: location_of(e), version: e.version.clone() }))
        .collect()
}

/// What "Desinstalar" runs: the install's own uninstaller, with no arguments so it shows its window.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Uninstaller {
    /// NSIS: `"C:\…\Chalito\uninstall.exe"`.
    Exe(PathBuf),
    /// MSI: `msiexec /x {GUID}`.
    Msi(String),
}

fn is_guid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 38
        && b[0] == b'{'
        && b[37] == b'}'
        && b[1..37].iter().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// UninstallString → the uninstaller. Any arguments it carries (a `/S`, say) are dropped.
pub fn uninstaller(cmd: &str) -> Option<Uninstaller> {
    let prog = command_program(cmd)?;
    let name = prog.to_string_lossy().rsplit(['\\', '/']).next()?.to_ascii_lowercase();
    if name == "msiexec.exe" || name == "msiexec" {
        let start = cmd.find('{')?;
        let guid = cmd.get(start..start + 38)?;
        return is_guid(guid).then(|| Uninstaller::Msi(guid.to_string()));
    }
    (is_abs(&prog.to_string_lossy()) && name.ends_with(".exe") && name.contains("uninst")).then_some(Uninstaller::Exe(prog))
}

/// The uninstall guard: a Chalito entry from a fresh read, not the running install, whose
/// uninstaller sits in its own folder. No known folder: it might be ours, so it's refused.
pub fn may_uninstall(id: &str, entries: &[Entry], running: &[String]) -> Result<Uninstaller, Refusal> {
    let e = entries.iter().find(|e| e.id == id && is_chalito_entry(e)).ok_or(Refusal::NotACopy)?;
    let location = location_of(e).filter(|l| is_abs(l)).ok_or(Refusal::NotACopy)?;
    let location = Some(location);
    if runs_from(location.as_deref(), running) {
        return Err(Refusal::Running);
    }
    match uninstaller(e.uninstall.as_deref().unwrap_or("")).ok_or(Refusal::NotACopy)? {
        Uninstaller::Exe(exe) if !location.as_deref().is_some_and(|l| holds(l, &exe.to_string_lossy())) => Err(Refusal::NotACopy),
        u => Ok(u),
    }
}

/// `*Chalito*setup*.exe` or `*Chalito*.msi`, any case: what the releases page hands out.
pub fn is_chalito_installer(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if let Some(stem) = n.strip_suffix(".exe") {
        return stem.find("chalito").is_some_and(|i| stem[i..].contains("setup"));
    }
    n.strip_suffix(".msi").is_some_and(|stem| stem.contains("chalito"))
}

fn installer_kind(name: &str) -> Option<CopyKind> {
    is_chalito_installer(name).then_some(CopyKind::Installer)
}

/// auto-launch's reading of Task Manager's switch: on unless the last 8 bytes hold a timestamp.
pub fn approved(value: Option<&[u8]>) -> bool {
    match value {
        Some(v) if v.len() >= 8 => v.iter().rev().take(8).all(|b| *b == 0),
        _ => true,
    }
}

/// Everything the check reads, gathered first so the decision runs on plain data.
#[derive(Default)]
pub struct Inputs {
    pub running: PathBuf,
    /// Downloads and Desktop (the known folders).
    pub folders: Vec<PathBuf>,
    pub entries: Vec<Entry>,
    /// Run values that Task Manager hasn't switched off, HKCU then HKLM.
    pub run: Vec<String>,
    pub handler: Option<String>,
}

fn canon_str(p: &Path) -> String {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()).display().to_string()
}

fn link_for(target: Option<PathBuf>, running: &Path) -> Link {
    let t = target.as_deref();
    let abs = t.is_some_and(|t| t.is_absolute() || is_abs(&t.to_string_lossy()));
    let same = t.is_some_and(|t| norm(&canon_str(t)) == norm(&canon_str(running)));
    copies::link_abs(t, abs, same, t.is_some_and(Path::is_file))
}

pub fn report(i: &Inputs) -> Report {
    let mut roots: Vec<(PathBuf, usize)> = i.folders.iter().map(|f| (f.clone(), 0)).collect();
    roots.dedup();
    Report {
        running: i.running.display().to_string(),
        autostart: copies::pick(i.run.iter().map(|v| link_for(command_program(v), &i.running))),
        handler: link_for(i.handler.as_deref().and_then(command_program), &i.running),
        copies: copies::scan_with(&roots, &i.running, installer_kind, None),
        installs: installs(&i.entries, &running_forms(&i.running)),
        ..Report::default()
    }
}

/// The installers the trash guard may take (`copies::may_trash` needs a fresh list).
pub fn found(i: &Inputs) -> Vec<OldCopy> {
    report(i).copies
}

#[cfg(windows)]
pub mod os {
    use super::*;
    use std::io;
    use std::os::windows::process::CommandExt as _;
    use std::process::Command;
    use windows_registry::{Key, CLASSES_ROOT, CURRENT_USER, LOCAL_MACHINE};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    /// ERROR_ELEVATION_REQUIRED: the per-machine uninstaller asks for admin.
    const ELEVATION_REQUIRED: i32 = 740;

    /// The uninstall entries under `root\path` (tests point it at their own HKCU key).
    pub fn entries_under(root: &Key, path: &str, scope: Scope, tag: &str) -> Vec<Entry> {
        let Ok(base) = root.open(path) else { return Vec::new() };
        let Ok(names) = base.keys() else { return Vec::new() };
        names
            .filter_map(|name| {
                let k = base.open(&name).ok()?;
                let s = |v: &str| k.get_string(v).ok().filter(|s| !s.is_empty());
                Some(Entry {
                    id: format!("{tag}\\{name}"),
                    scope: Some(scope),
                    display: s("DisplayName"),
                    publisher: s("Publisher"),
                    version: s("DisplayVersion"),
                    location: s("InstallLocation"),
                    uninstall: s("UninstallString"),
                })
            })
            .collect()
    }

    pub fn entries() -> Vec<Entry> {
        let mut out = entries_under(CURRENT_USER, UNINSTALL, Scope::User, "HKCU");
        out.extend(entries_under(LOCAL_MACHINE, UNINSTALL, Scope::Machine, "HKLM"));
        out
    }

    fn run_value(root: &Key) -> Option<String> {
        let v = root.open(RUN).ok()?.get_string(RUN_VALUE).ok()?;
        let flag = root.open(APPROVED).ok().and_then(|k| k.get_value(RUN_VALUE).ok());
        approved(flag.as_deref()).then_some(v)
    }

    pub fn inputs(running: PathBuf, folders: Vec<PathBuf>) -> Inputs {
        Inputs {
            running,
            folders,
            entries: entries(),
            run: [CURRENT_USER, LOCAL_MACHINE].into_iter().filter_map(run_value).collect(),
            handler: CLASSES_ROOT.open(HANDLER).ok().and_then(|k| k.get_string("").ok()),
        }
    }

    /// `%SystemRoot%\System32\…`: never a same-named program next to the app or on PATH.
    fn system32(exe: &str) -> PathBuf {
        let root = std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
        root.join("System32").join(exe)
    }

    fn powershell(script: &str, env: (&str, &Path)) -> io::Result<std::process::Output> {
        Command::new(system32(r"WindowsPowerShell\v1.0\powershell.exe"))
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env(env.0, env.1)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    }

    /// Exit 5: the person said no (a Recycle Bin or UAC dialog), which isn't an error.
    fn outcome(out: std::process::Output, what: &str) -> io::Result<()> {
        match out.status.code() {
            Some(0) => Ok(()),
            Some(3) => Err(io::Error::other(copies::NO_TRASH)),
            Some(5) => Err(io::Error::other(copies::CANCELLED)),
            _ => Err(io::Error::other(format!("{what}: {} {}", out.status, String::from_utf8_lossy(&out.stderr).trim()))),
        }
    }

    /// To the Recycle Bin through the shell (VB FileIO), never a delete. Off a fixed disk there's
    /// no bin, so it refuses; Windows asks the person itself before anything can't be recycled.
    pub fn trash(path: &Path) -> io::Result<()> {
        const SCRIPT: &str = concat!(
            "$ErrorActionPreference = 'Stop'; $p = $env:CHALITO_TRASH; ",
            "$root = [System.IO.Path]::GetPathRoot($p); ",
            r"if (-not $root -or $root.StartsWith('\\') -or ",
            "([System.IO.DriveInfo]::new($root)).DriveType -ne 'Fixed') { exit 3 }; ",
            "Add-Type -AssemblyName Microsoft.VisualBasic; ",
            "try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'AllDialogs', 'SendToRecycleBin') } ",
            "catch [System.OperationCanceledException] { exit 5 }; ",
            "if ([System.IO.File]::Exists($p)) { exit 4 }"
        );
        outcome(powershell(SCRIPT, ("CHALITO_TRASH", path))?, "recycle bin")
    }

    /// Starts the uninstaller with its own window, then returns: the person goes through it.
    pub fn launch(u: &Uninstaller) -> io::Result<()> {
        match u {
            Uninstaller::Exe(exe) if !exe.is_file() => Err(io::Error::other(Refusal::NotACopy.code())),
            Uninstaller::Exe(exe) => match Command::new(exe).spawn() {
                Ok(_) => Ok(()),
                Err(e) if e.raw_os_error() == Some(ELEVATION_REQUIRED) => {
                    // ShellExecute shows the UAC prompt that CreateProcess refuses to.
                    // A refused UAC prompt throws (ERROR_CANCELLED): that's the person's no.
                    const SCRIPT: &str = "$ErrorActionPreference = 'Stop'; try { Start-Process -FilePath $env:CHALITO_UNINSTALL } catch { if ($_.Exception.InnerException.NativeErrorCode -eq 1223 -or $_.Exception.NativeErrorCode -eq 1223) { exit 5 }; throw }";
                    outcome(powershell(SCRIPT, ("CHALITO_UNINSTALL", exe))?, "uninstaller")
                }
                Err(e) => Err(e),
            },
            Uninstaller::Msi(guid) => Command::new(system32("msiexec.exe")).args(["/x", guid]).spawn().map(|_| ()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, display: &str, location: Option<&str>, uninstall: Option<&str>) -> Entry {
        Entry {
            id: id.into(),
            scope: Some(if id.starts_with("HKLM") { Scope::Machine } else { Scope::User }),
            display: Some(display.into()),
            publisher: Some("chalyb".into()),
            version: Some("0.1.0-beta.2".into()),
            location: location.map(String::from),
            uninstall: uninstall.map(String::from),
        }
    }

    const USER_LOC: &str = r#""C:\Users\Ana\AppData\Local\Chalito""#;
    const USER_UNINST: &str = r#""C:\Users\Ana\AppData\Local\Chalito\uninstall.exe""#;
    const MACHINE_LOC: &str = r#""C:\Program Files\Chalito""#;
    const MACHINE_UNINST: &str = r#""C:\Program Files\Chalito\uninstall.exe""#;

    #[test]
    fn command_lines_name_their_program() {
        let p = |c: &str| command_program(c).map(|p| p.to_string_lossy().into_owned());
        // The NSIS installer's and the deep-link plugin's handler.
        assert_eq!(p(r#""C:\Program Files\Chalito\chalito-desktop.exe" "%1""#).as_deref(), Some(r"C:\Program Files\Chalito\chalito-desktop.exe"));
        // auto-launch: unquoted, with the trailing space of its empty argument list.
        assert_eq!(p(r"C:\Program Files\Chalito\Chalito.exe ").as_deref(), Some(r"C:\Program Files\Chalito\Chalito.exe"));
        assert_eq!(p(r"C:\Users\Ana\My Apps\Chalito.exe --x").as_deref(), Some(r"C:\Users\Ana\My Apps\Chalito.exe"));
        // `.exe` mid-folder-name isn't the end of the program; `.exe ` is, as Windows reads it.
        assert_eq!(p(r"C:\a.exed\Chalito.exe").as_deref(), Some(r"C:\a.exed\Chalito.exe"));
        assert_eq!(p(r"C:\Ana\My.exe stuff\Chalito.exe").as_deref(), Some(r"C:\Ana\My.exe"));
        assert_eq!(p("chalito --flag").as_deref(), Some("chalito"));
        assert_eq!(p(r#""""#), None);
        assert_eq!(p("   "), None);
        assert!(is_abs(r"C:\x") && is_abs(r"\\server\share\x.exe") && is_abs("d:/x"));
        assert!(!is_abs("chalito.exe") && !is_abs(r"C:x") && !is_abs("/usr/bin/x"));
    }

    #[test]
    fn the_chalito_entries_are_the_ones_named_chalito() {
        let mut e = entry("HKCU\\Chalito", "Chalito", None, None);
        assert!(is_chalito_entry(&e));
        e.display = Some(" chalito ".into());
        assert!(is_chalito_entry(&e));
        e.display = Some("Chalito Notes".into());
        assert!(!is_chalito_entry(&e));
        // Another chalyb product shares the publisher; only the name counts.
        e.display = Some("Chalyb Studio".into());
        assert!(!is_chalito_entry(&e));
        assert!(!is_chalito_entry(&entry("HKCU\\Cursor", "Cursor", None, None)));
    }

    #[test]
    fn installs_other_than_the_running_one_are_listed() {
        let entries = vec![
            entry("HKCU\\Chalito", "Chalito", Some(USER_LOC), Some(USER_UNINST)),
            entry("HKLM\\Chalito", "Chalito", Some(MACHINE_LOC), Some(MACHINE_UNINST)),
            entry("HKCU\\Cursor", "Cursor", Some(r"C:\Cursor"), Some(r"C:\Cursor\unins000.exe")),
        ];
        // Running the per-user copy: the per-machine one is the old copy.
        let one = |p: &str| vec![p.to_string()];
        let got = installs(&entries, &one(r"\\?\C:\Users\ana\AppData\Local\Chalito\chalito-desktop.exe"));
        assert_eq!(
            got,
            vec![Install {
                id: "HKLM\\Chalito".into(),
                scope: Scope::Machine,
                location: Some(r"C:\Program Files\Chalito".into()),
                version: Some("0.1.0-beta.2".into()),
            }]
        );
        // A copy run from elsewhere (a dev build, a copied exe): every install is another copy.
        assert_eq!(installs(&entries, &one(r"C:\Users\Ana\Downloads\chalito-desktop.exe")).len(), 2);
        // `C:\Program Files\Chalito2` is not inside `C:\Program Files\Chalito`.
        assert_eq!(installs(&entries, &one(r"C:\Program Files\Chalito2\chalito-desktop.exe")).len(), 2);
        // Either form of the running path is enough (a short `RUNNER~1` one and the long one).
        let forms = vec![r"C:\PROGRA~1\Chalito\x.exe".to_string(), r"\\?\C:\Program Files\Chalito\x.exe".to_string()];
        assert_eq!(installs(&entries, &forms).len(), 1);
        // No InstallLocation: the uninstaller's folder stands in.
        let bare = vec![entry("HKCU\\Chalito", "Chalito", None, Some(USER_UNINST))];
        assert!(installs(&bare, &one(r"C:\Users\Ana\AppData\Local\Chalito\chalito-desktop.exe")).is_empty());
        assert_eq!(location_of(&bare[0]).as_deref(), Some(r"C:\Users\Ana\AppData\Local\Chalito"));
    }

    #[test]
    fn the_uninstaller_is_the_installs_own_and_never_silent() {
        assert_eq!(uninstaller(MACHINE_UNINST), Some(Uninstaller::Exe(PathBuf::from(r"C:\Program Files\Chalito\uninstall.exe"))));
        // Arguments are dropped: the person sees the NSIS window.
        assert_eq!(uninstaller(r#""C:\Program Files\Chalito\uninstall.exe" /S"#), uninstaller(MACHINE_UNINST));
        let msi = "MsiExec.exe /X{0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9}";
        assert_eq!(uninstaller(msi), Some(Uninstaller::Msi("{0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9}".into())));
        for no in [
            "MsiExec.exe /X{bad} & calc",
            "MsiExec.exe /qn",
            r"C:\Windows\System32\cmd.exe /c del",
            "uninstall.exe",
            r#""C:\Chalito\Chalito.exe""#,
            "",
        ] {
            assert_eq!(uninstaller(no), None, "{no}");
        }
    }

    #[test]
    fn the_uninstall_guard_refuses_the_running_install_and_odd_entries() {
        let entries = vec![
            entry("HKCU\\Chalito", "Chalito", Some(USER_LOC), Some(USER_UNINST)),
            entry("HKLM\\Chalito", "Chalito", Some(MACHINE_LOC), Some(MACHINE_UNINST)),
            // An uninstaller outside its own folder.
            entry("HKCU\\Chalito2", "Chalito", Some(r"C:\Chalito2"), Some(r#""C:\Temp\uninstall.exe""#)),
            entry("HKCU\\Cursor", "Cursor", Some(r"C:\Cursor"), Some(r#""C:\Cursor\uninstall.exe""#)),
        ];
        let running = &[r"C:\Users\Ana\AppData\Local\Chalito\chalito-desktop.exe".to_string()];
        assert_eq!(may_uninstall("HKLM\\Chalito", &entries, running), uninstaller(MACHINE_UNINST).ok_or(Refusal::NotACopy));
        assert_eq!(may_uninstall("HKCU\\Chalito", &entries, running), Err(Refusal::Running));
        assert_eq!(may_uninstall("HKCU\\Chalito2", &entries, running), Err(Refusal::NotACopy));
        assert_eq!(may_uninstall("HKCU\\Cursor", &entries, running), Err(Refusal::NotACopy));
        assert_eq!(may_uninstall("HKCU\\Gone", &entries, running), Err(Refusal::NotACopy));
        // Only the uninstallable ones are listed: no button that would always be refused.
        let listed: Vec<String> = installs(&entries, running).into_iter().map(|i| i.id).collect();
        assert_eq!(listed, vec!["HKLM\\Chalito".to_string()]);
    }

    #[test]
    fn an_install_with_no_known_folder_fails_closed() {
        // An MSI entry without InstallLocation could be the running copy: never offered.
        let msi = entry("HKLM\\{0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9}", "Chalito", None, Some("MsiExec.exe /X{0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9}"));
        let running = &[r"C:\Program Files\Chalito\chalito-desktop.exe".to_string()];
        assert_eq!(may_uninstall(&msi.id, std::slice::from_ref(&msi), running), Err(Refusal::NotACopy));
        assert!(installs(std::slice::from_ref(&msi), running).is_empty());
        // With its folder known, it's judged like any other install.
        let mut placed = msi.clone();
        placed.location = Some(r"C:\Program Files\Chalito".into());
        assert_eq!(may_uninstall(&placed.id, std::slice::from_ref(&placed), running), Err(Refusal::Running));
        let elsewhere = &[r"C:\Users\Ana\AppData\Local\Chalito\chalito-desktop.exe".to_string()];
        assert!(matches!(may_uninstall(&placed.id, std::slice::from_ref(&placed), elsewhere), Ok(Uninstaller::Msi(_))));
        // A relative InstallLocation is no known folder either.
        let mut rel = placed.clone();
        rel.location = Some("Chalito".into());
        assert_eq!(may_uninstall(&rel.id, std::slice::from_ref(&rel), elsewhere), Err(Refusal::NotACopy));
    }

    #[test]
    fn downloaded_installers_are_recognised() {
        for yes in [
            "UNSIGNED_Chalito_0.1.0-beta.2_x64-setup.exe",
            "Chalito_0.1.0_x64-setup.exe",
            "chalito-setup.EXE",
            "Chalito_0.1.0_x64_en-US.msi",
            "Chalito Setup (1).exe",
        ] {
            assert!(is_chalito_installer(yes), "{yes}");
        }
        for no in ["setup-chalito.exe", "Chalito.exe", "chalito-desktop.exe", "Cursor-setup.exe", "Chalito_setup.exe.crdownload", "Chalito.msix"] {
            assert!(!is_chalito_installer(no), "{no}");
        }
        assert_eq!(copies::version_from_name("UNSIGNED_Chalito_0.1.0-beta.2_x64-setup.exe").as_deref(), Some("0.1.0-beta.2"));
        assert_eq!(copies::version_from_name("Chalito_0.1.0_x64_en-US.msi").as_deref(), Some("0.1.0"));
        assert_eq!(copies::version_from_name("Chalito-0.2.0-x64-setup.exe").as_deref(), Some("0.2.0"));
        assert_eq!(copies::version_from_name("chalito-setup.exe"), None);
    }

    #[test]
    fn task_manager_can_switch_a_run_value_off() {
        assert!(approved(None));
        assert!(approved(Some(&[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
        assert!(!approved(Some(&[3, 0, 0, 0, 0x5a, 0x1b, 0x2c, 0x3d, 0x4e, 0x5f, 0x60, 0x01])));
        assert!(approved(Some(&[3])));
    }

    #[test]
    fn several_entries_report_the_one_to_fix() {
        let other = Link::Other { path: "x".into() };
        assert_eq!(copies::pick([Link::Ours, other.clone()]), other);
        assert_eq!(copies::pick([Link::None, Link::Ours]), Link::Ours);
        assert_eq!(copies::pick([]), Link::None);
    }

    /// A temp folder standing in for Downloads, with the running exe elsewhere.
    #[cfg(windows)]
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("chalito-win-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[cfg(windows)]
    #[test]
    fn a_fake_uninstall_entry_in_the_registry_is_scanned() {
        use windows_registry::CURRENT_USER;
        /// Removes the test key even when an assert fails first.
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = CURRENT_USER.remove_tree(&self.0);
            }
        }
        let base = format!(r"Software\ChalitoCopiesTest-{}", std::process::id());
        let _cleanup = Cleanup(base.clone());
        let d = tmp("registry");
        let other = d.join("Program Files").join("Chalito");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("uninstall.exe"), b"MZ").unwrap();
        let key = CURRENT_USER.create(format!(r"{base}\Uninstall\Chalito")).unwrap();
        key.set_string("DisplayName", "Chalito").unwrap();
        key.set_string("Publisher", "chalyb").unwrap();
        key.set_string("DisplayVersion", "0.1.0-beta.1").unwrap();
        key.set_string("InstallLocation", format!("\"{}\"", other.display())).unwrap();
        key.set_string("UninstallString", format!("\"{}\"", other.join("uninstall.exe").display())).unwrap();
        CURRENT_USER.create(format!(r"{base}\Uninstall\NotUs")).unwrap().set_string("DisplayName", "Cursor").unwrap();

        let entries = os::entries_under(CURRENT_USER, &format!(r"{base}\Uninstall"), Scope::User, "HKCU");
        let running = running_forms(&d.join("Mine").join("chalito-desktop.exe"));
        let found = installs(&entries, &running);
        assert_eq!(found.len(), 1, "{entries:?}");
        assert_eq!(found[0].id, "HKCU\\Chalito");
        assert_eq!(found[0].version.as_deref(), Some("0.1.0-beta.1"));
        assert_eq!(found[0].location.as_deref(), Some(other.display().to_string().as_str()));
        assert_eq!(may_uninstall("HKCU\\Chalito", &entries, &running), Ok(Uninstaller::Exe(other.join("uninstall.exe"))));
        // Run from inside that install, it's the running copy: neither listed nor uninstallable.
        let inside = running_forms(&other.join("uninstall.exe"));
        assert!(installs(&entries, &inside).is_empty());
        assert_eq!(may_uninstall("HKCU\\Chalito", &entries, &inside), Err(Refusal::Running));

        CURRENT_USER.remove_tree(&base).unwrap();
        assert!(CURRENT_USER.open(&base).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(windows)]
    #[test]
    fn leftover_installers_are_found_and_the_recycle_guard_holds() {
        let d = tmp("installers");
        let dl = d.join("Downloads");
        std::fs::create_dir_all(dl.join("Chalito-setup-folder.exe")).unwrap();
        let running = d.join("Program Files").join("Chalito").join("chalito-desktop.exe");
        std::fs::create_dir_all(running.parent().unwrap()).unwrap();
        std::fs::write(&running, b"MZ").unwrap();
        let setup = dl.join("UNSIGNED_Chalito_0.1.0-beta.2_x64-setup.exe");
        let msi = dl.join("Chalito_0.1.0_x64_en-US.msi");
        for f in [&setup, &msi, &dl.join("Cursor-setup.exe"), &dl.join("notes-chalito.txt")] {
            std::fs::write(f, b"MZ").unwrap();
        }
        // The handler and the Run value on another existing copy, as an old install leaves them.
        let old = d.join("Old").join("chalito-desktop.exe");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, b"MZ").unwrap();
        let i = Inputs {
            running: running.clone(),
            folders: vec![dl.clone(), d.join("Desktop")],
            run: vec![format!("{} ", old.display())],
            handler: Some(format!("\"{}\" \"%1\"", running.display())),
            ..Inputs::default()
        };
        let r = report(&i);
        assert_eq!(r.autostart, Link::Other { path: old.display().to_string() });
        assert_eq!(r.handler, Link::Ours);
        let mut got: Vec<PathBuf> = r.copies.iter().map(|c| PathBuf::from(&c.path)).collect();
        got.sort();
        assert_eq!(got, vec![msi.clone(), setup.clone()]);
        assert!(r.copies.iter().all(|c| c.kind == CopyKind::Installer));

        assert_eq!(copies::may_trash(&setup, &running, &r.copies), Ok(()));
        assert_eq!(copies::may_trash(&running, &running, &r.copies), Err(Refusal::Running));
        assert_eq!(copies::may_trash(running.parent().unwrap(), &running, &r.copies), Err(Refusal::Running));
        assert_eq!(copies::may_trash(&dl.join("Cursor-setup.exe"), &running, &r.copies), Err(Refusal::NotACopy));
        let folder = dl.join("Chalito-setup-folder.exe");
        let forged = vec![OldCopy { path: folder.display().to_string(), kind: CopyKind::Installer, ..OldCopy::default() }];
        assert_eq!(copies::may_trash(&folder, &running, &forged), Err(Refusal::NotACopy));

        // The real Recycle Bin, on the runner's fixed disk; bounded so a dialog can't hang CI.
        let (tx, rx) = std::sync::mpsc::channel();
        let target = setup.clone();
        std::thread::spawn(move || tx.send(os::trash(&target).map_err(|e| e.to_string())));
        let res = rx.recv_timeout(std::time::Duration::from_secs(90)).expect("recycle bin timed out");
        assert_eq!(res, Ok(()));
        assert!(!setup.exists());
        // A network path has no Recycle Bin: refused, nothing touched.
        let unc = PathBuf::from(r"\\localhost\c$\no-such-dir\Chalito-setup.exe");
        assert_eq!(os::trash(&unc).map_err(|e| e.to_string()), Err(copies::NO_TRASH.to_string()));
        let _ = std::fs::remove_dir_all(&d);
    }
}
