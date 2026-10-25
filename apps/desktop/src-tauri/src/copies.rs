//! Other copies of Chalito: where autostart and chalito:// point, other copies, other processes.
//! Two copies ran at once and sign-in looped (owner, 2026-10-25); fixes run only on the person's click.
//! Linux lives here; Windows and macOS add theirs in copies_windows.rs and copies_macos.rs.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::autostart::xdg;

const DESKTOP_BIN: &str = "chalito-desktop";
const AGENT_BIN: &str = "chalito-agent";
const SCHEME_MIME: &str = "x-scheme-handler/chalito";
/// `use_this` wrote the handler but the desktop still opens chalito:// with another copy.
pub const HANDLER_NOT_SET: &str = "handler_not_set";
/// `use_this` ran but an autostart entry it can't change (Windows HKLM) still starts another copy.
pub const AUTOSTART_NOT_SET: &str = "autostart_not_set";
/// That drive has no trash to move to (Windows: not a fixed disk); nothing was touched.
pub const NO_TRASH: &str = "no_trash";
/// The handler file this app writes when it has to create one.
pub const HANDLER_ID: &str = "chalito.desktop";
/// `~/Applications/<folder>/<sub>/Chalito.AppImage` at most: AppImageLauncher and by-hand layouts.
pub const APPLICATIONS_DEPTH: usize = 2;
/// Entries read per folder: a huge Downloads folder stays a bounded read.
const MAX_ENTRIES: usize = 5000;

/// Where an OS entry (autostart, the chalito:// handler) sends Chalito.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Link {
    /// No entry, switched off, or a bare command resolved through PATH (someone's own edit).
    #[default]
    None,
    Ours,
    /// Names a file that is gone or can't run.
    Gone { path: String },
    /// Names another copy that exists: the mismatch behind the sign-in loop.
    Other { path: String },
}

impl Link {
    pub fn needs_fix(&self) -> bool {
        matches!(self, Link::Gone { .. } | Link::Other { .. })
    }
}

/// The mismatch decision. Reported, never fixed here: a test build opened once must not take over.
pub fn link(target: Option<&Path>, is_running: bool, runnable: bool) -> Link {
    link_abs(target, target.is_some_and(Path::is_absolute), is_running, runnable)
}

/// `link`, with "is it a full path" decided by the caller (`C:\…` isn't absolute to a Unix build).
pub fn link_abs(target: Option<&Path>, absolute: bool, is_running: bool, runnable: bool) -> Link {
    match target {
        None => Link::None,
        Some(_) if !absolute => Link::None,
        Some(_) if is_running => Link::Ours,
        Some(t) if runnable => Link::Other { path: t.display().to_string() },
        Some(t) => Link::Gone { path: t.display().to_string() },
    }
}

/// Several entries for one job (Windows HKCU and HKLM Run values): the one to fix, else ours.
pub fn pick(links: impl IntoIterator<Item = Link>) -> Link {
    let mut best = Link::None;
    for l in links {
        if l.needs_fix() {
            return l;
        }
        if l == Link::Ours {
            best = l;
        }
    }
    best
}

/// What an old copy is: the trash guard checks each kind its own way.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default)]
#[serde(rename_all = "snake_case")]
pub enum CopyKind {
    #[default]
    Appimage,
    /// A downloaded Windows installer (`*Chalito*setup*.exe`, `*Chalito*.msi`).
    Installer,
    /// Another `.app` bundle with Chalito's bundle id (macOS).
    App,
    Dmg,
}

/// Another copy: an AppImage, a downloaded installer or .dmg, or another .app bundle.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OldCopy {
    pub path: String,
    pub version: Option<String>,
    pub bytes: u64,
    pub kind: CopyKind,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    User,
    Machine,
}

/// A Windows install (an uninstall registry entry) other than the one running.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    /// `HKCU\Chalito` or `HKLM\Chalito`: what `copies_uninstall` gets back.
    pub id: String,
    pub scope: Scope,
    pub location: Option<String>,
    pub version: Option<String>,
}

/// Where the running app sits (macOS): from a mounted DMG or App Translocation it can't stay.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Placement {
    #[default]
    Ok,
    Dmg,
    Translocated,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Desktop,
    Agent,
}

/// A Chalito process that isn't this app or the agent it started.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub pid: u32,
    pub kind: Kind,
    pub path: String,
}

/// What the panel's notice shows (camelCase JSON for the webview).
#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub running: String,
    pub autostart: Link,
    pub handler: Link,
    pub copies: Vec<OldCopy>,
    pub instances: Vec<Instance>,
    pub installs: Vec<Install>,
    pub placement: Placement,
}

/// `*Chalito*.AppImage`, any case.
pub fn is_chalito_appimage(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.strip_suffix(".appimage").is_some_and(|stem| stem.contains("chalito"))
}

fn appimage_kind(name: &str) -> Option<CopyKind> {
    is_chalito_appimage(name).then_some(CopyKind::Appimage)
}

/// `UNSIGNED_Chalito_0.1.0-beta.2_amd64.AppImage` → `0.1.0-beta.2` (also `.exe`, `.msi`, `.dmg`).
pub fn version_from_name(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let ext = [".appimage", ".exe", ".msi", ".dmg"].into_iter().find_map(|e| lower.strip_suffix(e));
    let stem = &name[..ext.map_or(name.len(), str::len)];
    let b = stem.as_bytes();
    let starts_word = |i: usize| i == 0 || !b[i - 1].is_ascii_alphanumeric();
    let mut i = 0;
    while i < b.len() {
        let v_prefix = i >= 1 && matches!(b[i - 1], b'v' | b'V') && starts_word(i - 1);
        if !(b[i].is_ascii_digit() && (starts_word(i) || v_prefix)) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < b.len() && (b[j].is_ascii_digit() || b[j] == b'.') {
            j += 1;
        }
        let core = stem[i..j].trim_end_matches('.');
        if core.split('.').count() < 2 || core.split('.').any(str::is_empty) {
            i = j;
            continue;
        }
        let mut end = i + core.len();
        if b.get(end) == Some(&b'-') {
            let mut k = end + 1;
            while k < b.len() && (b[k].is_ascii_alphanumeric() || b[k] == b'.') {
                k += 1;
            }
            let pre = stem[end + 1..k].trim_end_matches('.');
            let arch = ["x86", "x64", "amd64", "aarch64", "arm", "i686", "linux", "universal", "setup", "darwin"].iter().any(|a| pre.to_ascii_lowercase().starts_with(a));
            if pre.starts_with(|c: char| c.is_ascii_alphabetic()) && !arch {
                end += 1 + pre.len();
            }
        }
        return Some(stem[i..end].to_string());
    }
    None
}

/// `XDG_DOWNLOAD_DIR="$HOME/Descargas"` from `user-dirs.dirs`: Spanish desktops rename the folders.
pub fn user_dir(user_dirs: &str, key: &str, home: &Path) -> Option<PathBuf> {
    let v = user_dirs.lines().find_map(|l| l.trim().strip_prefix(key)?.trim_start().strip_prefix('='))?;
    let v = v.trim().trim_matches('"');
    let p = match v.strip_prefix("$HOME") {
        Some(rest) => home.join(rest.trim_start_matches('/')),
        None => PathBuf::from(v),
    };
    (p.is_absolute() && p != home).then_some(p)
}

/// Folders to look in, each with how deep to go. Bounded on purpose: no walks of the whole home.
pub fn roots(home: &Path, user_dirs: Option<&str>, entry_targets: &[&Path]) -> Vec<(PathBuf, usize)> {
    let mut out: Vec<(PathBuf, usize)> = vec![
        (home.join("Applications"), APPLICATIONS_DEPTH),
        (home.join("Downloads"), 0),
        (home.join("Desktop"), 0),
        (home.to_path_buf(), 0),
    ];
    for key in ["XDG_DOWNLOAD_DIR", "XDG_DESKTOP_DIR"] {
        if let Some(p) = user_dirs.and_then(|u| user_dir(u, key, home)) {
            out.push((p, 0));
        }
    }
    for t in entry_targets {
        if let Some(parent) = t.parent().filter(|p| p.is_absolute()) {
            out.push((parent.to_path_buf(), 0));
        }
    }
    let mut seen = HashSet::new();
    out.retain(|(p, _)| seen.insert(p.clone()));
    out
}

fn canon(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Chalito AppImages under `roots`, the running one left out. Regular files only (no symlinks).
pub fn scan(roots: &[(PathBuf, usize)], running: &Path) -> Vec<OldCopy> {
    scan_with(roots, running, appimage_kind, None)
}

/// A file name's kind when it's one of ours.
pub type Matcher = fn(&str) -> Option<CopyKind>;
/// A `.app` folder's version (`Some(None)`: ours, no version), or None when it isn't Chalito.
pub type BundleCheck = fn(&Path) -> Option<Option<String>>;

/// Files `files` matches (and `.app` bundles `bundle` accepts, macOS) under `roots`.
pub fn scan_with(roots: &[(PathBuf, usize)], running: &Path, files: Matcher, bundle: Option<BundleCheck>) -> Vec<OldCopy> {
    let me = canon(running);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (root, depth) in roots {
        walk(root, *depth, &me, (files, bundle), &mut seen, &mut out);
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn walk(
    dir: &Path,
    depth: usize,
    me: &Path,
    find: (Matcher, Option<BundleCheck>),
    seen: &mut HashSet<PathBuf>,
    out: &mut Vec<OldCopy>,
) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.take(MAX_ENTRIES).flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path();
        if let (true, Some(check)) = (ft.is_dir() && is_app_name(&name), find.1) {
            // A bundle is a copy or nothing: never walked into.
            let Some(version) = check(&path) else { continue };
            let c = canon(&path);
            if c != me && !me.starts_with(&c) && seen.insert(c) {
                out.push(OldCopy { path: path.display().to_string(), version, bytes: 0, kind: CopyKind::App });
            }
            continue;
        }
        if ft.is_dir() {
            if depth > 0 && !name.starts_with('.') {
                walk(&path, depth - 1, me, find, seen, out);
            }
            continue;
        }
        let Some(kind) = ft.is_file().then(|| (find.0)(&name)).flatten() else { continue };
        let c = canon(&path);
        if c == me || !seen.insert(c) {
            continue;
        }
        let bytes = e.metadata().map_or(0, |m| m.len());
        out.push(OldCopy { path: path.display().to_string(), version: version_from_name(&name), bytes, kind });
    }
}

/// `Chalito.app`, `Chalito 2.APP`: a macOS bundle folder, by its name.
pub fn is_app_name(name: &str) -> bool {
    name.len() > 4 && name.to_ascii_lowercase().ends_with(".app")
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The copy this app runs from.
    Running,
    /// Not a copy the scan found (a renamed file, a folder, anything else).
    NotACopy,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::Running => "running",
            Refusal::NotACopy => "not_a_copy",
        }
    }
}

/// The trash-safety guard: only a copy from a fresh scan that is still what the scan saw, and
/// never ours or the bundle ours runs inside.
pub fn may_trash(path: &Path, running: &Path, found: &[OldCopy]) -> Result<(), Refusal> {
    let (c, me) = (canon(path), canon(running));
    if c == me || me.starts_with(&c) {
        return Err(Refusal::Running);
    }
    let Some(copy) = found.iter().find(|c| Path::new(&c.path) == path) else { return Err(Refusal::NotACopy) };
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let meta = fs::symlink_metadata(path).ok();
    let file = meta.as_ref().is_some_and(fs::Metadata::is_file);
    let still = match copy.kind {
        CopyKind::Appimage => file && is_chalito_appimage(name),
        CopyKind::Installer => file && crate::copies_windows::is_chalito_installer(name),
        CopyKind::Dmg => file && crate::copies_macos::is_chalito_dmg(name),
        CopyKind::App => meta.is_some_and(|m| m.is_dir()) && is_app_name(name),
    };
    if still && path.is_absolute() {
        Ok(())
    } else {
        Err(Refusal::NotACopy)
    }
}

/// Moves `path` to the trash: `gio trash`, else the freedesktop home trash. Never deletes.
pub fn trash(path: &Path, data_home: &Path) -> io::Result<()> {
    match Command::new("gio").arg("trash").arg("--").arg(path).status() {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(io::Error::other(format!("gio trash: {s}"))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => home_trash(path, data_home, &local_now()).map(|_| ()),
        Err(e) => Err(e),
    }
}

/// The freedesktop trash spec's home trash. A rename only: across filesystems it fails, it never copies and deletes.
pub fn home_trash(path: &Path, data_home: &Path, deleted_at: &str) -> io::Result<PathBuf> {
    let files = data_home.join("Trash").join("files");
    let info = data_home.join("Trash").join("info");
    for d in [&files, &info] {
        let mut b = fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
        b.create(d)?;
    }
    let name = path.file_name().ok_or_else(|| io::Error::other("no file name"))?.to_string_lossy().into_owned();
    for n in 1..1000 {
        let slot = if n == 1 { name.clone() } else { format!("{name}.{n}") };
        let info_path = info.join(format!("{slot}.trashinfo"));
        // The spec's reservation: whoever creates the .trashinfo first owns the name.
        let mut f = match fs::OpenOptions::new().write(true).create_new(true).open(&info_path) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        let dest = files.join(&slot);
        if fs::symlink_metadata(&dest).is_ok() {
            drop(f);
            fs::remove_file(&info_path)?;
            continue;
        }
        let r = write!(f, "[Trash Info]\nPath={}\nDeletionDate={deleted_at}\n", percent_path(path))
            .and_then(|_| fs::rename(path, &dest));
        if let Err(e) = r {
            let _ = fs::remove_file(&info_path);
            return Err(e);
        }
        return Ok(dest);
    }
    Err(io::Error::other("trash is full of that name"))
}

fn percent_path(p: &Path) -> String {
    let mut out = String::new();
    for &b in p.to_string_lossy().as_bytes() {
        if b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(unix)]
fn local_now() -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    // SAFETY: localtime_r writes only into `tm`, which lives on this stack frame.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let secs = t as libc::time_t;
    unsafe { libc::localtime_r(&secs, &mut tm) };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

#[cfg(not(unix))]
fn local_now() -> String {
    String::from("1970-01-01T00:00:00")
}

/// A process as the OS lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub exe: PathBuf,
    /// The AppImage file it runs from, when it runs from one.
    pub image: Option<PathBuf>,
    /// Its executable is inside an AppImage mount (`/tmp/.mount_…`), live or already unmounted.
    pub in_mount: bool,
}

/// `chalito-desktop`, `chalito-agent.exe`, `… (deleted)` → the bare binary name, lowercase.
pub fn bin_name(exe: &Path) -> String {
    let n = exe.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let n = n.strip_suffix(" (deleted)").unwrap_or(&n);
    n.strip_suffix(".exe").unwrap_or(n).to_string()
}

/// Other Chalito apps, and AppImage agents whose app is gone (PR #105 makes them exit with it).
/// The OS service and `chalito run` start the agent from elsewhere, so they're never listed.
pub fn others(procs: &[Proc], me: u32) -> Vec<Instance> {
    let apps: HashSet<u32> = procs.iter().filter(|p| bin_name(&p.exe) == DESKTOP_BIN).map(|p| p.pid).collect();
    procs
        .iter()
        .filter(|p| p.pid != me)
        .filter_map(|p| {
            let path = p.image.as_ref().unwrap_or(&p.exe).display().to_string();
            match bin_name(&p.exe).as_str() {
                DESKTOP_BIN => Some(Instance { pid: p.pid, kind: Kind::Desktop, path }),
                AGENT_BIN if p.in_mount && p.ppid != me && !apps.contains(&p.ppid) => {
                    Some(Instance { pid: p.pid, kind: Kind::Agent, path })
                }
                _ => None,
            }
        })
        .collect()
}

/// `PPid:` from `/proc/<pid>/status`.
pub fn status_ppid(status: &str) -> Option<u32> {
    status.lines().find_map(|l| l.strip_prefix("PPid:")?.trim().parse().ok())
}

/// One variable from `/proc/<pid>/environ` (NUL-separated `KEY=value`).
pub fn environ_var(environ: &[u8], key: &str) -> Option<OsString> {
    environ.split(|&b| b == 0).find_map(|kv| {
        let rest = kv.strip_prefix(key.as_bytes())?.strip_prefix(b"=")?;
        Some(OsString::from(String::from_utf8_lossy(rest).into_owned()))
    })
}

/// `pid ppid /path/to/exe` lines (`ps -o pid=,ppid=,comm=` on macOS, PowerShell on Windows).
pub fn parse_proc_lines(out: &str) -> Vec<(u32, u32, PathBuf)> {
    out.lines()
        .filter_map(|l| {
            let l = l.trim_start();
            let (pid, rest) = l.split_once(char::is_whitespace)?;
            let (ppid, exe) = rest.trim_start().split_once(char::is_whitespace)?;
            let exe = exe.trim();
            (!exe.is_empty()).then(|| Some((pid.parse().ok()?, ppid.parse().ok()?, PathBuf::from(exe))))?
        })
        .collect()
}

/// An AppImage's sidecar (`/tmp/.mount_…`, still in the path once unmounted). A bare
/// `(deleted)` isn't enough: updating the service's copy or the deb leaves one too.
pub fn in_appimage_mount(exe: &Path) -> bool {
    exe.to_string_lossy().contains("/.mount_")
}

/// Chalito processes of this user (other users' exe links can't be read, so they're skipped).
#[cfg(target_os = "linux")]
pub fn processes() -> Vec<Proc> {
    let Ok(entries) = fs::read_dir("/proc") else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|e| {
            let pid: u32 = e.file_name().to_str()?.parse().ok()?;
            let dir = e.path();
            let exe = fs::read_link(dir.join("exe")).ok()?;
            if ![DESKTOP_BIN, AGENT_BIN].contains(&bin_name(&exe).as_str()) {
                return None;
            }
            let ppid = status_ppid(&fs::read_to_string(dir.join("status")).ok()?)?;
            let env = fs::read(dir.join("environ")).unwrap_or_default();
            let target =
                crate::autostart::launch_target(environ_var(&env, "APPIMAGE"), environ_var(&env, "APPDIR"), exe.clone());
            let image = (target != exe).then_some(target);
            Some(Proc { pid, ppid, in_mount: in_appimage_mount(&exe), exe, image })
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
pub fn processes() -> Vec<Proc> {
    #[cfg(target_os = "macos")]
    let out = Command::new("/bin/ps").args(["-x", "-o", "pid=,ppid=,comm="]).output();
    #[cfg(windows)]
    let out = {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.ExecutablePath }";
        Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    };
    #[cfg(not(any(target_os = "macos", windows)))]
    let out: io::Result<std::process::Output> = Err(io::Error::other("unsupported"));
    let Ok(out) = out else { return Vec::new() };
    parse_proc_lines(&String::from_utf8_lossy(&out.stdout))
        .into_iter()
        .filter(|(_, _, exe)| [DESKTOP_BIN, AGENT_BIN].contains(&bin_name(exe).as_str()))
        .map(|(pid, ppid, exe)| Proc { pid, ppid, in_mount: in_appimage_mount(&exe), exe, image: None })
        .collect()
}

/// Asks a process to quit (SIGTERM; on Windows, taskkill without /F, which asks it to close).
pub fn terminate(pid: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        // SAFETY: kill(2) with a pid the caller just found among this user's Chalito processes.
        if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        let s = Command::new("taskkill").args(["/PID", &pid.to_string()]).creation_flags(0x0800_0000).status()?;
        if s.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!("taskkill: {s}")))
        }
    }
}

/// `$XDG_DATA_HOME`, or `~/.local/share` when unset or relative.
pub fn data_home(home: &Path, xdg_data_home: Option<&std::ffi::OsStr>) -> PathBuf {
    xdg_data_home.map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".local/share"))
}

/// `$XDG_DATA_DIRS`, or the spec's default.
pub fn data_dirs(xdg_data_dirs: Option<&str>) -> Vec<PathBuf> {
    let raw = xdg_data_dirs.filter(|s| !s.is_empty()).unwrap_or("/usr/local/share:/usr/share");
    raw.split(':').map(PathBuf::from).filter(|p| p.is_absolute()).collect()
}

/// `xdg-mime query default x-scheme-handler/chalito` output → a desktop file id.
pub fn parse_handler_id(out: &str) -> Option<String> {
    let id = out.trim();
    (id.ends_with(".desktop") && !id.contains('/') && id.len() > ".desktop".len()).then(|| id.to_string())
}

/// The handler's `.desktop` file: the id under each data dir, user's first (XDG precedence).
pub fn handler_file(id: &str, data_home: &Path, data_dirs: &[PathBuf]) -> Option<PathBuf> {
    std::iter::once(data_home).chain(data_dirs.iter().map(PathBuf::as_path)).map(|d| d.join("applications").join(id)).find(|p| p.is_file())
}

/// The program an entry starts, reading tauri-plugin-autostart's unquoted paths with spaces too.
pub fn entry_program(entry: &str) -> Option<PathBuf> {
    let t = xdg::exec_target(entry);
    if t.as_deref().is_some_and(|t| t.is_relative() || xdg::runnable(t)) {
        return t;
    }
    // Hand-written handlers do the same, with a trailing field code: `Exec=/My Apps/Chalito.AppImage %U`.
    let raw = xdg::main_group(entry).find_map(|(k, v)| (k == "Exec").then_some(v)).map(|v| {
        let mut v = v.trim_end();
        while let Some((head, _)) = v.rsplit_once(' ').filter(|(_, l)| l.starts_with('%') && l.len() == 2) {
            v = head.trim_end();
        }
        PathBuf::from(v)
    });
    match raw {
        Some(r) if r.is_absolute() && xdg::runnable(&r) => Some(r),
        _ => t,
    }
}

/// The handler entry pointed at `exec` (an `Exec` value from `xdg::exec_value`), the rest kept.
pub fn with_exec(entry: &str, exec: &str) -> String {
    let line = format!("Exec={exec} %U");
    let mut out = Vec::new();
    let (mut in_main, mut done) = (false, false);
    for l in entry.lines() {
        let t = l.trim();
        if t.starts_with('[') {
            if in_main && !done {
                out.push(line.clone());
                done = true;
            }
            in_main = t == "[Desktop Entry]";
        } else if in_main && t.split_once('=').is_some_and(|(k, _)| k.trim() == "TryExec") {
            // A TryExec naming the old copy would hide the entry once that copy is trashed.
            continue;
        } else if in_main && t.split_once('=').is_some_and(|(k, _)| k.trim() == "Exec") {
            if !done {
                out.push(line.clone());
                done = true;
            }
            continue;
        }
        out.push(l.to_string());
    }
    if in_main && !done {
        out.push(line);
        done = true;
    }
    if !done {
        return new_handler(exec);
    }
    out.join("\n") + "\n"
}

/// A fresh handler entry, when there's none in the user's data folder to edit.
pub fn new_handler(exec: &str) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=Chalito\nExec={exec} %U\nTerminal=false\nNoDisplay=true\nMimeType={SCHEME_MIME};\n"
    )
}

/// Paths and environment the check reads (Linux).
pub struct Ctx {
    pub home: PathBuf,
    pub running: PathBuf,
    pub autostart_dir: PathBuf,
    pub data_home: PathBuf,
    pub data_dirs: Vec<PathBuf>,
    pub user_dirs: Option<String>,
    /// Run xdg-mime and update-desktop-database (off in tests: they'd change the real desktop).
    pub os_tools: bool,
}

impl Ctx {
    pub fn from_env(home: PathBuf, running: PathBuf) -> Self {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".config"));
        Ctx {
            autostart_dir: config.join("autostart"),
            data_home: data_home(&home, std::env::var_os("XDG_DATA_HOME").as_deref()),
            data_dirs: data_dirs(std::env::var("XDG_DATA_DIRS").ok().as_deref()),
            user_dirs: fs::read_to_string(config.join("user-dirs.dirs")).ok(),
            os_tools: true,
            home,
            running,
        }
    }

    fn autostart_target(&self) -> Option<PathBuf> {
        match xdg::state(&self.autostart_dir) {
            Ok(xdg::State::Live | xdg::State::Dangling) => {
                entry_program(&fs::read_to_string(self.autostart_dir.join(xdg::ENTRY)).ok()?)
            }
            _ => None,
        }
    }

    fn handler_path(&self) -> Option<PathBuf> {
        let id = self
            .os_tools
            .then(|| Command::new("xdg-mime").args(["query", "default", SCHEME_MIME]).output().ok())
            .flatten()
            .and_then(|o| parse_handler_id(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_else(|| HANDLER_ID.to_string());
        handler_file(&id, &self.data_home, &self.data_dirs)
    }

    /// The other AppImages only (the trash guard's list), without the entries' links.
    pub fn copies(&self) -> Vec<OldCopy> {
        self.report().copies
    }

    fn handler_target(&self) -> Option<PathBuf> {
        entry_program(&fs::read_to_string(self.handler_path()?).ok()?)
    }

    fn link_for(&self, target: Option<&Path>) -> Link {
        let running = canon(&self.running);
        link(target, target.is_some_and(|t| canon(t) == running), target.is_some_and(xdg::runnable))
    }

    /// The file part of the check: entries and other AppImages.
    pub fn report(&self) -> Report {
        let auto = self.autostart_target();
        let handler = self.handler_target();
        let targets: Vec<&Path> = [auto.as_deref(), handler.as_deref()].into_iter().flatten().collect();
        let roots = roots(&self.home, self.user_dirs.as_deref(), &targets);
        Report {
            running: self.running.display().to_string(),
            autostart: self.link_for(auto.as_deref()),
            handler: self.link_for(handler.as_deref()),
            copies: scan(&roots, &self.running),
            ..Report::default()
        }
    }

    /// "Usar esta copia": autostart (only if it's on) and the chalito:// handler start this copy.
    /// Reads everything first, then the handler (the sign-in fix), then autostart.
    pub fn use_this(&self) -> io::Result<()> {
        let autostart_on = matches!(xdg::state(&self.autostart_dir)?, xdg::State::Live | xdg::State::Dangling);
        let exec = xdg::exec_value(&self.running)?;
        let apps = self.data_home.join("applications");
        let own = self.handler_path().filter(|p| p.starts_with(&apps));
        let (file, body) = match &own {
            Some(p) => (p.clone(), with_exec(&fs::read_to_string(p)?, &exec)),
            None => (apps.join(HANDLER_ID), new_handler(&exec)),
        };
        fs::create_dir_all(&apps)?;
        let tmp = apps.join(format!(".{HANDLER_ID}.{}.tmp", std::process::id()));
        fs::write(&tmp, body)?;
        if let Err(e) = fs::rename(&tmp, &file) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        if autostart_on {
            xdg::write(&self.autostart_dir, &self.running)?;
        }
        if !self.os_tools {
            return Ok(());
        }
        if let Err(e) = Command::new("update-desktop-database").arg(&apps).status() {
            eprintln!("copies: update-desktop-database: {e}");
        }
        let id = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        match Command::new("xdg-mime").args(["default", &id, SCHEME_MIME]).status() {
            Ok(s) if s.success() => {}
            r => eprintln!("copies: xdg-mime default {id}: {r:?}"),
        }
        // Said "done" while links still opened the other copy, the sign-in loop would stay.
        if self.link_for(self.handler_target().as_deref()).needs_fix() {
            return Err(io::Error::other(HANDLER_NOT_SET));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("chalito-copies-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn file_at(p: &Path) -> PathBuf {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        p.to_path_buf()
    }

    /// Compared as paths, not strings: on Windows `join("a/b")` keeps the slash, read_dir doesn't.
    fn paths(c: &[OldCopy]) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = c.iter().map(|c| PathBuf::from(&c.path)).collect();
        v.sort();
        v
    }

    #[cfg(unix)] // Windows paths have a drive; these are XDG paths.
    #[test]
    fn an_entry_on_another_existing_copy_is_a_mismatch() {
        let other = Path::new("/home/ana/chalito-dl-test/UNSIGNED_Chalito_0.1.0-beta.2_amd64.AppImage");
        assert_eq!(link(Some(other), false, true), Link::Other { path: other.display().to_string() });
        assert!(link(Some(other), false, true).needs_fix());
        assert_eq!(link(Some(other), true, true), Link::Ours);
        assert_eq!(link(Some(other), false, false), Link::Gone { path: other.display().to_string() });
        assert_eq!(link(None, false, false), Link::None);
        // A bare command (`chalito-desktop %u` from the deb, or someone's own edit) isn't judged.
        assert_eq!(link(Some(Path::new("chalito-desktop")), false, true), Link::None);
        assert!(!Link::Ours.needs_fix() && !Link::None.needs_fix());
    }

    #[test]
    fn the_name_pattern_is_chalito_appimage_any_case() {
        for yes in ["Chalito.AppImage", "UNSIGNED_Chalito_0.1.0-beta.2_amd64.AppImage", "chalito.appimage", "Chalito.beta2.AppImage", "my-CHALITO-old.APPIMAGE"] {
            assert!(is_chalito_appimage(yes), "{yes}");
        }
        for no in ["Chalito.AppImage.part", "Cursor.AppImage", ".AppImage", "chalito", "chalito.deb", "Chalito.AppImage.zsync", "x.appimage-chalito"] {
            assert!(!is_chalito_appimage(no), "{no}");
        }
    }

    #[test]
    fn the_version_comes_from_the_file_name() {
        let v = |n: &str| version_from_name(n);
        assert_eq!(v("UNSIGNED_Chalito_0.1.0-beta.2_amd64.AppImage").as_deref(), Some("0.1.0-beta.2"));
        assert_eq!(v("Chalito_0.1.0_amd64.AppImage").as_deref(), Some("0.1.0"));
        assert_eq!(v("Chalito-0.2.1-x86_64.AppImage").as_deref(), Some("0.2.1"));
        assert_eq!(v("Chalito-v1.4.AppImage").as_deref(), Some("1.4"));
        assert_eq!(v("Chalito 0.1.0-rc.1.AppImage").as_deref(), Some("0.1.0-rc.1"));
        assert_eq!(v("Chalito.AppImage"), None);
        assert_eq!(v("Chalito.beta2.AppImage"), None);
        assert_eq!(v("Chalito_x86_64.AppImage"), None);
        assert_eq!(v("Chalito-1.0.0-linux-x86_64.AppImage").as_deref(), Some("1.0.0"));
        assert_eq!(v("Chalito_ñandú_0.3.0-beta.1.AppImage").as_deref(), Some("0.3.0-beta.1"));
        assert_eq!(v("Chalito_ñ.AppImage"), None);
    }

    #[cfg(unix)] // Windows paths have a drive; these are XDG paths.
    #[test]
    fn localized_download_and_desktop_folders_are_read() {
        let home = Path::new("/home/ana");
        let dirs = "# comment\nXDG_DESKTOP_DIR=\"$HOME/Escritorio\"\nXDG_DOWNLOAD_DIR=\"$HOME/Descargas\"\nXDG_MUSIC_DIR=\"/mnt/m\"\n";
        assert_eq!(user_dir(dirs, "XDG_DOWNLOAD_DIR", home), Some(home.join("Descargas")));
        assert_eq!(user_dir(dirs, "XDG_MUSIC_DIR", home), Some(PathBuf::from("/mnt/m")));
        // `$HOME/` alone means "no such folder": never the whole home a second time.
        assert_eq!(user_dir("XDG_DESKTOP_DIR=\"$HOME/\"\n", "XDG_DESKTOP_DIR", home), None);
        let r = roots(home, Some(dirs), &[Path::new("/home/ana/chalito-dl-test/x.AppImage"), Path::new("relative")]);
        assert!(r.contains(&(home.join("Applications"), APPLICATIONS_DEPTH)));
        assert!(r.contains(&(home.join("Descargas"), 0)) && r.contains(&(home.join("Escritorio"), 0)));
        assert!(r.contains(&(home.join("chalito-dl-test"), 0)));
        assert!(r.iter().all(|(p, d)| *d == 0 || p == &home.join("Applications")));
        assert_eq!(r.iter().filter(|(p, _)| p == home).count(), 1);
    }

    /// The owner's machine on 2026-10-25, in a temp dir: the scan, then the trash guard.
    #[test]
    fn the_scan_finds_the_other_copies_and_the_guard_protects_ours() {
        let d = tmp("scan");
        let home = d.join("home");
        let running = file_at(&home.join("Applications/chalito/Chalito.AppImage"));
        let beta2 = file_at(&home.join("Applications/chalito/Chalito.beta2.AppImage"));
        let test = file_at(&home.join("chalito-dl-test/UNSIGNED_Chalito_0.1.0-beta.2_amd64.AppImage"));
        let dl = file_at(&home.join("Downloads/Chalito_0.1.0-beta.1_amd64.AppImage"));
        let deep = file_at(&home.join("Applications/a/b/c/Chalito.AppImage"));
        let two_deep = file_at(&home.join("Applications/a/b/Chalito-0.0.9.AppImage"));
        let in_docs = file_at(&home.join("Documents/Chalito.AppImage"));
        let hidden = file_at(&home.join("Applications/.cache/Chalito.AppImage"));
        file_at(&home.join("Downloads/Cursor.AppImage"));
        file_at(&home.join("Downloads/chalito-notes.txt"));
        fs::create_dir_all(home.join("Downloads/Chalito-dir.AppImage")).unwrap();
        fs::create_dir_all(home.join("Desktop")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&running, home.join("Desktop/Chalito.AppImage")).unwrap();

        let r = roots(&home, None, &[test.as_path()]);
        let found = scan(&r, &running);
        let mut want = vec![beta2.clone(), test.clone(), dl.clone(), two_deep.clone()];
        want.sort();
        assert_eq!(paths(&found), want);
        for not in [&running, &deep, &in_docs, &hidden] {
            assert!(!paths(&found).contains(not), "{}", not.display());
        }
        let t = found.iter().find(|c| Path::new(&c.path) == test).unwrap();
        assert_eq!(t.version.as_deref(), Some("0.1.0-beta.2"));
        assert_eq!(t.bytes, 10);
        // Without the entry's folder in the roots, the test copy is out of reach.
        assert!(!paths(&scan(&roots(&home, None, &[]), &running)).contains(&test));

        assert_eq!(may_trash(&test, &running, &found), Ok(()));
        assert_eq!(may_trash(&running, &running, &found), Err(Refusal::Running));
        #[cfg(unix)]
        assert_eq!(may_trash(&home.join("Desktop/Chalito.AppImage"), &running, &found), Err(Refusal::Running));
        let notes = home.join("Downloads/chalito-notes.txt");
        assert_eq!(may_trash(&notes, &running, &[OldCopy { path: notes.display().to_string(), ..OldCopy::default() }]), Err(Refusal::NotACopy));
        assert_eq!(may_trash(&in_docs, &running, &found), Err(Refusal::NotACopy), "not from the scan");
        assert_eq!(may_trash(&home.join("Downloads/Chalito-dir.AppImage"), &running, &found), Err(Refusal::NotACopy));
        assert_eq!(may_trash(Path::new("relative/Chalito.AppImage"), &running, &found), Err(Refusal::NotACopy));
        // Each check on its own: listed by a (stale or forged) scan, still refused.
        let listed = |p: &Path| vec![OldCopy { path: p.display().to_string(), ..OldCopy::default() }];
        let dir = home.join("Downloads/Chalito-dir.AppImage");
        assert_eq!(may_trash(&dir, &running, &listed(&dir)), Err(Refusal::NotACopy));
        #[cfg(unix)]
        {
            let link = home.join("Downloads/Chalito-link.AppImage");
            std::os::unix::fs::symlink(&beta2, &link).unwrap();
            assert_eq!(may_trash(&link, &running, &listed(&link)), Err(Refusal::NotACopy));
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)] // Windows paths have a drive; these are XDG paths.
    #[test]
    fn the_home_trash_moves_the_file_and_records_where_it_was() {
        let d = tmp("trash");
        let data = d.join("share");
        let a = file_at(&d.join("dl test/Chalito 0.1.AppImage"));
        let dest = home_trash(&a, &data, "2026-10-25T10:00:00").unwrap();
        assert!(!a.exists() && dest.is_file());
        let info = fs::read_to_string(data.join("Trash/info/Chalito 0.1.AppImage.trashinfo")).unwrap();
        assert!(info.starts_with("[Trash Info]\nPath=/"), "{info}");
        assert!(info.contains("dl%20test/Chalito%200.1.AppImage\nDeletionDate=2026-10-25T10:00:00\n"), "{info}");
        // Same name again: a second slot, the first one untouched.
        let b = file_at(&d.join("dl test/Chalito 0.1.AppImage"));
        let dest2 = home_trash(&b, &data, "2026-10-25T10:01:00").unwrap();
        assert_ne!(dest, dest2);
        assert!(dest.is_file() && dest2.is_file());
        // Nothing to move: an error, and no reservation left behind.
        assert!(home_trash(&d.join("gone.AppImage"), &data, "x").is_err());
        assert!(!data.join("Trash/info/gone.AppImage.trashinfo").exists());
        let _ = fs::remove_dir_all(&d);
    }

    fn proc(pid: u32, ppid: u32, exe: &str) -> Proc {
        Proc { pid, ppid, exe: PathBuf::from(exe), image: None, in_mount: in_appimage_mount(Path::new(exe)) }
    }

    #[test]
    fn other_apps_and_orphaned_agents_are_found_ours_are_not() {
        let me = 100;
        let mut other = proc(200, 1, "/tmp/.mount_ChalitX/usr/bin/chalito-desktop");
        other.image = Some(PathBuf::from("/home/ana/chalito-dl-test/UNSIGNED_Chalito_0.1.0-beta.2_amd64.AppImage"));
        let procs = vec![
            proc(me, 1, "/tmp/.mount_ChalitY/usr/bin/chalito-desktop"),
            proc(101, me, "/tmp/.mount_ChalitY/usr/bin/chalito-agent"),
            other,
            proc(201, 200, "/tmp/.mount_ChalitX/usr/bin/chalito-agent"),
            proc(300, 1, "/tmp/.mount_ChalitZ/usr/bin/chalito-agent (deleted)"),
            proc(301, 999, "/tmp/.mount_ChalitW/usr/bin/chalito-agent"),
            // The background service and `chalito run`: never orphans, whoever their parent is.
            proc(400, 1, "/home/ana/.local/share/chalito/chalito-agent"),
            proc(401, 1, "/usr/bin/chalito-agent"),
            proc(402, 1, "/home/ana/.local/share/chalito/chalito-agent (deleted)"),
            proc(500, 1, "/Applications/Chalito.app/Contents/MacOS/chalito-agent"),
            proc(501, 77, "C:/Program Files/Chalito/chalito-agent.exe"),
        ];
        let got = others(&procs, me);
        assert_eq!(
            got,
            vec![
                Instance { pid: 200, kind: Kind::Desktop, path: "/home/ana/chalito-dl-test/UNSIGNED_Chalito_0.1.0-beta.2_amd64.AppImage".into() },
                Instance { pid: 300, kind: Kind::Agent, path: "/tmp/.mount_ChalitZ/usr/bin/chalito-agent (deleted)".into() },
                Instance { pid: 301, kind: Kind::Agent, path: "/tmp/.mount_ChalitW/usr/bin/chalito-agent".into() },
            ]
        );
        assert!(others(&procs[..2], me).is_empty());
    }

    #[test]
    fn process_listings_are_parsed() {
        assert_eq!(status_ppid("Name:\tchalito-desktop\nPid:\t7\nPPid:\t1234\n"), Some(1234));
        assert_eq!(status_ppid("Name: x\n"), None);
        let env = b"HOME=/home/ana\0APPIMAGE=/home/ana/Chalito.AppImage\0APPDIR=/tmp/.mount_X\0APPIMAGEX=no\0";
        assert_eq!(environ_var(env, "APPIMAGE"), Some(OsString::from("/home/ana/Chalito.AppImage")));
        assert_eq!(environ_var(env, "APPDIR"), Some(OsString::from("/tmp/.mount_X")));
        assert_eq!(environ_var(env, "APP"), None);
        let ps = "  123     1 /Applications/Chalito.app/Contents/MacOS/chalito-desktop\n 456 123 /Users/ana/My Apps/Chalito.app/Contents/MacOS/chalito-agent\n789 4 \nbad line\n";
        assert_eq!(
            parse_proc_lines(ps),
            vec![
                (123, 1, PathBuf::from("/Applications/Chalito.app/Contents/MacOS/chalito-desktop")),
                (456, 123, PathBuf::from("/Users/ana/My Apps/Chalito.app/Contents/MacOS/chalito-agent")),
            ]
        );
        assert_eq!(bin_name(Path::new("/x/Chalito-Desktop.EXE")), "chalito-desktop");
        assert_eq!(bin_name(Path::new("/tmp/.mount_A/usr/bin/chalito-agent (deleted)")), "chalito-agent");
    }

    #[cfg(unix)] // Windows paths have a drive; these are XDG paths.
    #[test]
    fn the_handler_is_found_where_xdg_mime_says() {
        assert_eq!(parse_handler_id("chalito.desktop\n").as_deref(), Some("chalito.desktop"));
        assert_eq!(parse_handler_id("\n"), None);
        assert_eq!(parse_handler_id("../x.desktop"), None);
        assert_eq!(data_dirs(None), vec![PathBuf::from("/usr/local/share"), PathBuf::from("/usr/share")]);
        assert_eq!(data_dirs(Some("/a:rel:/b")), vec![PathBuf::from("/a"), PathBuf::from("/b")]);
        assert_eq!(data_home(Path::new("/home/ana"), Some("rel".as_ref())), PathBuf::from("/home/ana/.local/share"));
        let d = tmp("handler");
        let user = d.join("share");
        let sys = d.join("usr/share");
        fs::create_dir_all(sys.join("applications")).unwrap();
        fs::write(sys.join("applications/chalito.desktop"), "").unwrap();
        assert_eq!(handler_file("chalito.desktop", &user, &[sys.clone()]), Some(sys.join("applications/chalito.desktop")));
        fs::create_dir_all(user.join("applications")).unwrap();
        fs::write(user.join("applications/chalito.desktop"), "").unwrap();
        assert_eq!(handler_file("chalito.desktop", &user, &[sys]), Some(user.join("applications/chalito.desktop")));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_handler_entry_is_repointed_and_the_rest_kept() {
        let owner = "[Desktop Entry]\nName=Chalito\nTryExec=/home/ana/Applications/chalito/Chalito.AppImage\nExec=/home/ana/Applications/chalito/Chalito.AppImage %U\nIcon=/x.png\nMimeType=x-scheme-handler/chalito;\n[Desktop Action New]\nExec=/other\n";
        let out = with_exec(owner, "\"/home/ana/New/Chalito.AppImage\"");
        assert_eq!(
            out,
            "[Desktop Entry]\nName=Chalito\nExec=\"/home/ana/New/Chalito.AppImage\" %U\nIcon=/x.png\nMimeType=x-scheme-handler/chalito;\n[Desktop Action New]\nExec=/other\n"
        );
        assert_eq!(entry_program(&out), Some(PathBuf::from("/home/ana/New/Chalito.AppImage")));
        // No Exec line: added at the end of the main group.
        assert_eq!(with_exec("[Desktop Entry]\nName=C\n[X]\nA=b\n", "/c"), "[Desktop Entry]\nName=C\nExec=/c %U\n[X]\nA=b\n");
        // Not a desktop entry at all: a fresh one.
        assert_eq!(with_exec("junk", "/c"), new_handler("/c"));
        assert!(new_handler("/c").contains("MimeType=x-scheme-handler/chalito;"));
    }

    fn ctx_for(d: &Path, running: &Path) -> Ctx {
        let home = d.join("home");
        Ctx {
            autostart_dir: xdg::dir(&home, None),
            home,
            running: running.to_path_buf(),
            data_home: d.join("share"),
            data_dirs: vec![d.join("usr/share")],
            user_dirs: None,
            os_tools: false,
        }
    }

    #[cfg(unix)]
    #[test]
    fn use_this_points_both_entries_at_the_running_copy() {
        let d = tmp("use-this");
        let home = d.join("home");
        let running = file_at(&home.join("Applications/chalito/Chalito.AppImage"));
        // A space in the folder: tauri-plugin-autostart wrote such paths unquoted.
        let test = file_at(&home.join("chalito dl test/UNSIGNED_Chalito_0.1.0-beta.2_amd64.AppImage"));
        let ctx = ctx_for(&d, &running);
        fs::create_dir_all(&ctx.autostart_dir).unwrap();
        fs::write(ctx.autostart_dir.join(xdg::ENTRY), format!("[Desktop Entry]\nExec={} \nTerminal=false", test.display())).unwrap();
        // The owner's handler, in the user's data folder, on the same old copy.
        let user_handler = ctx.data_home.join("applications").join(HANDLER_ID);
        fs::create_dir_all(user_handler.parent().unwrap()).unwrap();
        let owner = format!("[Desktop Entry]\nName=Chalito\nTryExec={0}\nExec={0} %U\nIcon=/x/chalito.png\nMimeType=x-scheme-handler/chalito;\n", test.display());
        fs::write(&user_handler, owner).unwrap();
        let r = ctx.report();
        assert_eq!(r.autostart, Link::Other { path: test.display().to_string() });
        assert_eq!(r.handler, Link::Other { path: test.display().to_string() });
        assert_eq!(paths(&r.copies), vec![test.clone()]);

        ctx.use_this().unwrap();
        let entry = fs::read_to_string(ctx.autostart_dir.join(xdg::ENTRY)).unwrap();
        assert_eq!(xdg::exec_target(&entry), Some(running.clone()));
        let handler = fs::read_to_string(&user_handler).unwrap();
        assert_eq!(entry_program(&handler), Some(running.clone()));
        assert!(handler.contains("Icon=/x/chalito.png") && !handler.contains("TryExec"), "{handler}");
        let r = ctx.report();
        assert_eq!((r.autostart, r.handler), (Link::Ours, Link::Ours));
        // Autostart switched off: "Usar esta copia" leaves it off.
        xdg::disable(&ctx.autostart_dir, &xdg::legacy_dir(&home)).unwrap();
        ctx.use_this().unwrap();
        assert!(!ctx.autostart_dir.join(xdg::ENTRY).exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn a_system_handler_is_overridden_in_the_users_folder_never_edited() {
        let d = tmp("use-this-system");
        let running = file_at(&d.join("home/Applications/Chalito.AppImage"));
        let other = file_at(&d.join("opt/chalito/chalito-desktop"));
        let ctx = ctx_for(&d, &running);
        let system = d.join("usr/share/applications").join(HANDLER_ID);
        fs::create_dir_all(system.parent().unwrap()).unwrap();
        let body = format!("[Desktop Entry]\nExec={} %u\n", other.display());
        fs::write(&system, &body).unwrap();
        assert_eq!(ctx.report().handler, Link::Other { path: other.display().to_string() });
        ctx.use_this().unwrap();
        assert_eq!(fs::read_to_string(&system).unwrap(), body);
        let user = fs::read_to_string(ctx.data_home.join("applications").join(HANDLER_ID)).unwrap();
        assert!(user.contains("MimeType=x-scheme-handler/chalito;"));
        assert_eq!(ctx.report().handler, Link::Ours);
        // Autostart was never on: still no entry.
        assert!(!ctx.autostart_dir.join(xdg::ENTRY).exists());
        let _ = fs::remove_dir_all(&d);
    }
}
