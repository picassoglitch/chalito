//! "Instalar el comando chalito": puts the bundled agent on the person's PATH as `chalito`, so
//! `chalito pair`, `chalito keys set …` and `chalito claude pin` work in any terminal.
//! Only after the person confirms in the panel.
//!
//! - Linux: `~/.local/bin/chalito` → the sidecar. An AppImage's sidecar lives in a mount that
//!   changes every run, so it is copied to `~/.local/share/chalito/chalito-agent` first (and
//!   refreshed when the app updates).
//! - macOS: `/usr/local/bin/chalito` → `Chalito.app/Contents/MacOS/chalito-agent`, through the
//!   system's administrator prompt. Refused while the app runs from the DMG or a quarantine copy.
//! - Windows: `%LOCALAPPDATA%\Chalito\bin\chalito.cmd` calls the sidecar; that folder is added to
//!   the user's PATH (no administrator rights; new terminals pick it up).
//!
//! An existing `chalito` that isn't ours is never replaced.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Linux,
    Macos,
    Windows,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Os::Macos
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

pub struct Input {
    pub os: Os,
    /// The bundled agent (agent::sidecar_path).
    pub sidecar: PathBuf,
    pub home: PathBuf,
    /// `$APPIMAGE` when running as an AppImage (Linux).
    pub appimage: bool,
    /// `%LOCALAPPDATA%` (Windows).
    pub local_app_data: Option<PathBuf>,
    /// `$PATH` / `%PATH%`, to tell the person whether a new terminal finds the command.
    pub path_env: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// Copies the sidecar to a stable place (AppImage), 0755, through a temp file + rename.
    Copy { from: PathBuf, to: PathBuf },
    /// `link` → `target`; refused when `link` exists and isn't a link to a chalito-agent.
    Symlink { target: PathBuf, link: PathBuf },
    WriteFile { path: PathBuf, contents: String },
    /// A command run as is (the macOS admin prompt, the Windows user-PATH update).
    Run { program: String, args: Vec<String> },
}

#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub steps: Vec<Step>,
    /// Where `chalito` will be.
    pub command: PathBuf,
    /// The folder the command is in (to check against PATH).
    pub dir: PathBuf,
    /// Whether that folder is on PATH already (else the panel says how to add it).
    pub on_path: bool,
    /// The OS asks for an administrator password (macOS).
    pub admin_prompt: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallError {
    /// Dev and unwired builds carry no agent to install.
    NoSidecar,
    /// macOS: running from the DMG or an App Translocation copy; move Chalito to Applications.
    MoveToApplications,
    /// Windows without %LOCALAPPDATA%.
    NoLocalAppData,
    /// A `chalito` that isn't ours is already there.
    Exists,
    /// The administrator prompt was cancelled.
    Cancelled,
    Failed,
}

pub fn on_path(path_env: &str, dir: &Path, os: Os) -> bool {
    let sep = if os == Os::Windows { ';' } else { ':' };
    let norm = |s: &str| {
        let t = s.trim_end_matches(['/', '\\']);
        if os == Os::Windows { t.to_lowercase() } else { t.to_string() }
    };
    let want = norm(&dir.to_string_lossy());
    path_env.split(sep).any(|p| !p.is_empty() && norm(p) == want)
}

/// AppleScript string literal: backslashes and quotes escaped.
fn applescript_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// PowerShell single-quoted literal.
fn ps_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub fn plan(i: &Input) -> Result<Plan, InstallError> {
    match i.os {
        Os::Linux => {
            let dir = i.home.join(".local").join("bin");
            let command = dir.join("chalito");
            let mut steps = Vec::new();
            let target = if i.appimage {
                let stable = i.home.join(".local").join("share").join("chalito").join("chalito-agent");
                steps.push(Step::Copy { from: i.sidecar.clone(), to: stable.clone() });
                stable
            } else {
                i.sidecar.clone()
            };
            steps.push(Step::Symlink { target, link: command.clone() });
            Ok(Plan { on_path: on_path(&i.path_env, &dir, i.os), steps, command, dir, admin_prompt: false })
        }
        Os::Macos => {
            let s = i.sidecar.to_string_lossy();
            if !(s.starts_with("/Applications/") || s.starts_with(&format!("{}/Applications/", i.home.display())))
                || s.contains("/AppTranslocation/")
            {
                return Err(InstallError::MoveToApplications);
            }
            let dir = PathBuf::from("/usr/local/bin");
            let command = dir.join("chalito");
            let script = format!(
                "do shell script \"mkdir -p /usr/local/bin && ln -sfn \" & quoted form of {} & \" /usr/local/bin/chalito\" with administrator privileges with prompt {}",
                applescript_str(&s),
                applescript_str("Chalito quiere instalar el comando chalito. / Chalito wants to install the chalito command.")
            );
            Ok(Plan {
                steps: vec![Step::Run { program: "/usr/bin/osascript".into(), args: vec!["-e".into(), script] }],
                on_path: true, // /usr/local/bin is in /etc/paths
                command,
                dir,
                admin_prompt: true,
            })
        }
        Os::Windows => {
            let base = i.local_app_data.as_ref().ok_or(InstallError::NoLocalAppData)?;
            let dir = base.join("Chalito").join("bin");
            let command = dir.join("chalito.cmd");
            let d = dir.to_string_lossy();
            let ps = format!(
                "$d={}; $p=[Environment]::GetEnvironmentVariable('Path','User'); if ($null -eq $p) {{ $p='' }}; \
                 if (-not (($p -split ';') -contains $d)) {{ [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';'), $d) -join ';').TrimStart(';'), 'User') }}",
                ps_str(&d)
            );
            Ok(Plan {
                steps: vec![
                    Step::WriteFile {
                        path: command.clone(),
                        contents: format!("@echo off\r\n\"{}\" %*\r\n", i.sidecar.display()),
                    },
                    Step::Run {
                        program: "powershell.exe".into(),
                        args: vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), ps],
                    },
                ],
                // The user PATH changes for new terminals; this process's PATH doesn't show it.
                on_path: true,
                command,
                dir,
                admin_prompt: false,
            })
        }
    }
}

/// Is `p` ours: a link to a chalito-agent, or (Windows) our shim?
pub fn is_ours(p: &Path) -> bool {
    if let Ok(target) = fs::read_link(p) {
        return target.file_name().is_some_and(|n| n.to_string_lossy().starts_with("chalito-agent"));
    }
    p.extension().is_some_and(|e| e == "cmd")
        && fs::read_to_string(p).is_ok_and(|s| s.starts_with("@echo off") && s.contains("chalito-agent"))
}

fn copy_atomic(from: &Path, to: &Path) -> std::io::Result<()> {
    let dir = to.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(".chalito-agent.tmp");
    fs::copy(from, &tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))?;
    }
    fs::rename(tmp, to)
}

/// Runs a plan. The `Run` step's exit status decides cancelled (macOS -128) vs failed.
pub fn execute(plan: &Plan) -> Result<(), InstallError> {
    if plan.command.symlink_metadata().is_ok() && !is_ours(&plan.command) {
        return Err(InstallError::Exists);
    }
    for step in &plan.steps {
        match step {
            Step::Copy { from, to } => copy_atomic(from, to).map_err(|_| InstallError::Failed)?,
            Step::Symlink { target, link } => {
                #[cfg(unix)]
                {
                    fs::create_dir_all(link.parent().ok_or(InstallError::Failed)?).map_err(|_| InstallError::Failed)?;
                    if link.symlink_metadata().is_ok() {
                        fs::remove_file(link).map_err(|_| InstallError::Failed)?;
                    }
                    std::os::unix::fs::symlink(target, link).map_err(|_| InstallError::Failed)?;
                }
                #[cfg(not(unix))]
                {
                    let _ = (target, link);
                    return Err(InstallError::Failed);
                }
            }
            Step::WriteFile { path, contents } => {
                fs::create_dir_all(path.parent().ok_or(InstallError::Failed)?).map_err(|_| InstallError::Failed)?;
                fs::write(path, contents).map_err(|_| InstallError::Failed)?;
            }
            Step::Run { program, args } => {
                let out = Command::new(program).args(args).output().map_err(|_| InstallError::Failed)?;
                if !out.status.success() {
                    // osascript: "User canceled. (-128)"
                    let err = String::from_utf8_lossy(&out.stderr);
                    return Err(if err.contains("-128") { InstallError::Cancelled } else { InstallError::Failed });
                }
            }
        }
    }
    Ok(())
}

/// AppImage updates replace the sidecar: keep an installed copy current (at app start).
pub fn refresh_copy(plan: &Plan) {
    for step in &plan.steps {
        if let Step::Copy { from, to } = step {
            let differs = match (fs::read(from), fs::read(to)) {
                (Ok(a), Ok(b)) => a != b,
                _ => false, // not installed (or unreadable): leave it
            };
            if differs && plan.command.symlink_metadata().is_ok() && is_ours(&plan.command) {
                let _ = copy_atomic(from, to);
            }
        }
    }
}

/// For the panel: is the command installed, where, and will a new terminal find it.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub os: Os,
    pub installed: bool,
    pub command: Option<String>,
    pub on_path: bool,
    pub admin_prompt: bool,
    /// Why it can't be installed from here (no sidecar, run from the DMG…).
    pub unavailable: Option<InstallError>,
}

pub fn status(input: Option<&Input>, os: Os) -> CliStatus {
    let Some(i) = input else {
        return CliStatus { os, installed: false, command: None, on_path: false, admin_prompt: false, unavailable: Some(InstallError::NoSidecar) };
    };
    match plan(i) {
        Ok(p) => CliStatus {
            os,
            installed: p.command.symlink_metadata().is_ok() && is_ours(&p.command),
            command: Some(p.command.to_string_lossy().into_owned()),
            on_path: p.on_path,
            admin_prompt: p.admin_prompt,
            unavailable: None,
        },
        Err(e) => CliStatus { os, installed: false, command: None, on_path: false, admin_prompt: false, unavailable: Some(e) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(os: Os, sidecar: &str) -> Input {
        Input {
            os,
            sidecar: PathBuf::from(sidecar),
            home: PathBuf::from("/home/ana"),
            appimage: false,
            local_app_data: Some(PathBuf::from(r"C:\Users\Ana\AppData\Local")),
            path_env: "/usr/bin:/home/ana/.local/bin".into(),
        }
    }

    #[test]
    fn linux_links_into_local_bin() {
        let p = plan(&input(Os::Linux, "/usr/bin/chalito-agent")).unwrap();
        assert_eq!(
            p.steps,
            vec![Step::Symlink { target: "/usr/bin/chalito-agent".into(), link: "/home/ana/.local/bin/chalito".into() }]
        );
        assert!(p.on_path);
        assert!(!p.admin_prompt);
    }

    #[test]
    fn linux_appimage_copies_out_of_the_mount_first() {
        let mut i = input(Os::Linux, "/tmp/.mount_ChalitXYZ/usr/bin/chalito-agent");
        i.appimage = true;
        i.path_env = "/usr/bin".into();
        let p = plan(&i).unwrap();
        let stable = PathBuf::from("/home/ana/.local/share/chalito/chalito-agent");
        assert_eq!(
            p.steps,
            vec![
                Step::Copy { from: i.sidecar.clone(), to: stable.clone() },
                Step::Symlink { target: stable, link: "/home/ana/.local/bin/chalito".into() },
            ]
        );
        assert!(!p.on_path, "~/.local/bin isn't on this PATH: the panel says so");
    }

    #[test]
    fn macos_asks_for_the_admin_password_and_quotes_the_path() {
        let p = plan(&input(Os::Macos, "/Applications/Chalito \"Beta\".app/Contents/MacOS/chalito-agent")).unwrap();
        assert!(p.admin_prompt);
        assert_eq!(p.command, PathBuf::from("/usr/local/bin/chalito"));
        let Step::Run { program, args } = &p.steps[0] else { panic!() };
        assert_eq!(program, "/usr/bin/osascript");
        assert!(args[1].contains(r#"quoted form of "/Applications/Chalito \"Beta\".app/Contents/MacOS/chalito-agent""#));
        assert!(args[1].contains("with administrator privileges"));
        assert!(plan(&input(Os::Macos, "/Users/ana/Applications/Chalito.app/Contents/MacOS/chalito-agent")).is_err());
        let mut home_apps = input(Os::Macos, "/home/ana/Applications/Chalito.app/Contents/MacOS/chalito-agent");
        home_apps.home = "/home/ana".into();
        assert!(plan(&home_apps).is_ok());
    }

    #[test]
    fn macos_refuses_the_dmg_and_translocation() {
        for s in [
            "/Volumes/Chalito/Chalito.app/Contents/MacOS/chalito-agent",
            "/private/var/folders/x/AppTranslocation/1/d/Chalito.app/Contents/MacOS/chalito-agent",
            "/Applications/../private/var/AppTranslocation/Chalito.app/Contents/MacOS/chalito-agent",
        ] {
            assert_eq!(plan(&input(Os::Macos, s)), Err(InstallError::MoveToApplications), "{s}");
        }
    }

    #[test]
    fn windows_writes_a_shim_and_adds_its_folder_to_the_user_path() {
        let p = plan(&input(Os::Windows, r"C:\Program Files\Chalito\chalito-agent.exe")).unwrap();
        assert_eq!(p.command, PathBuf::from(r"C:\Users\Ana\AppData\Local").join("Chalito").join("bin").join("chalito.cmd"));
        let Step::WriteFile { contents, .. } = &p.steps[0] else { panic!() };
        assert_eq!(contents, "@echo off\r\n\"C:\\Program Files\\Chalito\\chalito-agent.exe\" %*\r\n");
        let Step::Run { program, args } = &p.steps[1] else { panic!() };
        assert_eq!(program, "powershell.exe");
        assert!(args[3].contains("'User'"));
        let mut none = input(Os::Windows, "x");
        none.local_app_data = None;
        assert_eq!(plan(&none), Err(InstallError::NoLocalAppData));
    }

    #[test]
    fn powershell_and_applescript_literals_escape_quotes() {
        assert_eq!(ps_str("C:\\Users\\O'Brien"), "'C:\\Users\\O''Brien'");
        assert_eq!(applescript_str("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn path_matching() {
        assert!(on_path("/usr/bin:/home/ana/.local/bin/", Path::new("/home/ana/.local/bin"), Os::Linux));
        assert!(!on_path("/usr/bin", Path::new("/home/ana/.local/bin"), Os::Linux));
        assert!(on_path(r"C:\Windows;c:\users\ana\appdata\local\chalito\bin\", Path::new(r"C:\Users\Ana\AppData\Local\Chalito\bin"), Os::Windows));
    }

    #[cfg(unix)]
    #[test]
    fn installs_on_unix_and_never_replaces_someone_elses_chalito() {
        let root = std::env::temp_dir().join(format!("chalito-cli-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let sidecar = root.join("chalito-agent");
        fs::write(&sidecar, "v1").unwrap();
        let mut i = input(Os::Linux, sidecar.to_str().unwrap());
        i.home = root.join("home");
        i.appimage = true;
        let p = plan(&i).unwrap();

        execute(&p).unwrap();
        assert_eq!(fs::read_to_string(&p.command).unwrap(), "v1");
        assert!(status(Some(&i), Os::Linux).installed);
        // Again (idempotent), and an AppImage update is copied on the next start.
        execute(&p).unwrap();
        fs::write(&sidecar, "v2").unwrap();
        refresh_copy(&p);
        assert_eq!(fs::read_to_string(&p.command).unwrap(), "v2");

        fs::remove_file(&p.command).unwrap();
        fs::write(&p.command, "#!/bin/sh\necho someone else's\n").unwrap();
        assert_eq!(execute(&p), Err(InstallError::Exists));
        assert!(!status(Some(&i), Os::Linux).installed);
        assert!(fs::read_to_string(&p.command).unwrap().contains("someone else's"));
    }
}
