//! macOS side of copies.rs: other Chalito.app bundles and .dmg files, running from a DMG or App
//! Translocation, and where the LaunchAgent and chalito:// point. Fixes run only on a click.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::fs;
use std::path::{Path, PathBuf};

use crate::copies::{self, CopyKind, Link, OldCopy, Placement, Report};

/// tauri.conf.json's `identifier`: every Chalito.app has it, whatever the folder is called.
pub const BUNDLE_ID: &str = "com.chalyb.chalito";
/// tauri-plugin-autostart's LaunchAgent: `~/Library/LaunchAgents/<productName>.plist`.
pub const AGENT: &str = "Library/LaunchAgents/Chalito.plist";
pub const LSREGISTER: &str =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// `<key>K</key><string>V</string>` from an XML plist (Info.plist, the LaunchAgent).
pub fn plist_string(xml: &str, key: &str) -> Option<String> {
    let tag = format!("<key>{key}</key>");
    let rest = xml[xml.find(&tag)? + tag.len()..].trim_start().strip_prefix("<string>")?;
    Some(unescape(&rest[..rest.find("</string>")?]))
}

/// The program a LaunchAgent starts: the first string of its ProgramArguments.
pub fn agent_program(xml: &str) -> Option<PathBuf> {
    let rest = &xml[xml.find("<key>ProgramArguments</key>")?..];
    let rest = rest[rest.find("<array>")?..].split("</array>").next()?;
    let s = &rest[rest.find("<string>")? + "<string>".len()..];
    Some(PathBuf::from(unescape(&s[..s.find("</string>")?])))
}

/// The `.app` an executable runs inside (`…/Chalito.app/Contents/MacOS/chalito-desktop`).
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().skip(1).find(|a| a.file_name().and_then(|n| n.to_str()).is_some_and(copies::is_app_name)).map(Path::to_path_buf)
}

/// Opened straight from the DMG window (a read-only volume) or moved by App Translocation (an
/// app run from Downloads with the quarantine flag): updates and login items break from there.
pub fn placement(bundle: &Path, read_only: bool) -> Placement {
    let s = bundle.to_string_lossy();
    if s.contains("/AppTranslocation/") {
        Placement::Translocated
    } else if s.starts_with("/Volumes/") && read_only {
        Placement::Dmg
    } else {
        Placement::Ok
    }
}

/// `*Chalito*.dmg`, any case.
pub fn is_chalito_dmg(name: &str) -> bool {
    name.to_ascii_lowercase().strip_suffix(".dmg").is_some_and(|stem| stem.contains("chalito"))
}

fn dmg_kind(name: &str) -> Option<CopyKind> {
    is_chalito_dmg(name).then_some(CopyKind::Dmg)
}

/// An XML Info.plist, converting a binary one with `plutil` (macOS only).
fn info_plist(bundle: &Path) -> Option<String> {
    let file = bundle.join("Contents/Info.plist");
    let bytes = fs::read(&file).ok()?;
    if !bytes.starts_with(b"bplist") {
        return Some(String::from_utf8_lossy(&bytes).into_owned());
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/bin/plutil").args(["-convert", "xml1", "-o", "-"]).arg(&file).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// A bundle with Chalito's id → its CFBundleShortVersionString (`copies::BundleCheck`).
pub fn bundle_version(bundle: &Path) -> Option<Option<String>> {
    let xml = info_plist(bundle)?;
    (plist_string(&xml, "CFBundleIdentifier")?.trim() == BUNDLE_ID).then(|| plist_string(&xml, "CFBundleShortVersionString"))
}

/// Where other bundles and .dmg files sit. `/Applications/Utilities`-style subfolders are read too.
pub fn roots(applications: &Path, home: &Path, downloads: Option<&Path>, desktop: Option<&Path>) -> Vec<(PathBuf, usize)> {
    let mut out = vec![(applications.to_path_buf(), 1), (home.join("Applications"), 1)];
    out.extend([downloads, desktop].into_iter().flatten().map(|p| (p.to_path_buf(), 0)));
    let mut seen = std::collections::HashSet::new();
    out.retain(|(p, _)| seen.insert(p.clone()));
    out
}

/// Everything the check reads, gathered first so the decision runs on plain data.
#[derive(Default)]
pub struct Inputs {
    /// The running executable (inside the bundle).
    pub running: PathBuf,
    pub applications: PathBuf,
    pub home: PathBuf,
    pub downloads: Option<PathBuf>,
    pub desktop: Option<PathBuf>,
    /// The LaunchAgent's XML, when there is one.
    pub agent: Option<String>,
    /// The app LaunchServices opens chalito:// with.
    pub handler: Option<PathBuf>,
    /// The running bundle's volume is read-only.
    pub read_only: bool,
}

fn canon(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// From a DMG or a translocated mirror, an identical bundle elsewhere is this very copy (its
/// original) or the one to move to: never offered for the trash.
fn same_build(a: &Path, b: &Path) -> bool {
    let read = |p: &Path| fs::read(p.join("Contents/Info.plist")).ok();
    read(a).is_some_and(|x| read(b).is_some_and(|y| x == y))
}

pub fn report(i: &Inputs) -> Report {
    let bundle = bundle_of(&i.running);
    let me = bundle.clone().unwrap_or_else(|| i.running.clone());
    let placement = bundle.as_deref().map_or(Placement::Ok, |b| placement(b, i.read_only));
    let (exe, me_c) = (canon(&i.running), canon(&me));
    // The LaunchAgent names the executable (or the bundle, in AppleScript mode).
    let auto = i.agent.as_deref().and_then(agent_program);
    let autostart = auto.as_deref().map_or(Link::None, |t| {
        let c = canon(t);
        copies::link(Some(t), c == exe || c == me_c, t.exists())
    });
    let handler = i.handler.as_deref().map_or(Link::None, |h| copies::link(Some(h), canon(h) == me_c, h.is_dir()));
    let roots = roots(&i.applications, &i.home, i.downloads.as_deref(), i.desktop.as_deref());
    let mut found = copies::scan_with(&roots, &me, dmg_kind, Some(bundle_version));
    if placement != Placement::Ok {
        found.retain(|c| c.kind != CopyKind::App || !same_build(Path::new(&c.path), &me));
    }
    Report { running: me.display().to_string(), autostart, handler, copies: found, placement, ..Report::default() }
}

/// The copies the trash guard may take (`copies::may_trash` needs a fresh list).
pub fn found(i: &Inputs) -> Vec<OldCopy> {
    report(i).copies
}

#[cfg(target_os = "macos")]
pub mod os {
    use super::*;
    use std::io;
    use std::process::Command;

    const OSASCRIPT: &str = "/usr/bin/osascript";

    fn jxa(script: &str, arg: Option<&Path>) -> io::Result<String> {
        let mut c = Command::new(OSASCRIPT);
        c.args(["-l", "JavaScript", "-e", script]);
        if let Some(a) = arg {
            c.arg(a);
        }
        let out = c.output()?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(io::Error::other(String::from_utf8_lossy(&out.stderr).trim().to_string()))
        }
    }

    /// The app LaunchServices opens chalito:// with, by path (all copies share one bundle id).
    pub fn handler() -> Option<PathBuf> {
        const JS: &str = "ObjC.import('AppKit'); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString('chalito://open')); u.isNil() ? '' : ObjC.unwrap(u.path)";
        jxa(JS, None).ok().filter(|p| p.starts_with('/')).map(PathBuf::from)
    }

    /// statvfs's read-only flag: a mounted DMG, or the translocation mirror.
    pub fn read_only(p: &Path) -> bool {
        use std::os::unix::ffi::OsStrExt as _;
        let Ok(c) = std::ffi::CString::new(p.as_os_str().as_bytes()) else { return false };
        // SAFETY: statvfs fills `st`, a zeroed struct on this stack frame, from a NUL-terminated path.
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        unsafe { libc::statvfs(c.as_ptr(), &mut st) == 0 && st.f_flag & libc::ST_RDONLY != 0 }
    }

    pub fn inputs(running: PathBuf, home: PathBuf, downloads: Option<PathBuf>, desktop: Option<PathBuf>) -> Inputs {
        let read_only = bundle_of(&running).is_some_and(|b| read_only(&b));
        Inputs {
            agent: fs::read_to_string(home.join(AGENT)).ok(),
            handler: handler(),
            applications: PathBuf::from("/Applications"),
            read_only,
            running,
            home,
            downloads,
            desktop,
        }
    }

    /// NSFileManager trashItemAtURL (JXA, path as an argument, never in the script), else the
    /// Finder. A move to the Trash, never `rm`.
    pub fn trash(path: &Path) -> io::Result<()> {
        const JS: &str = "function run(argv) { ObjC.import('Foundation'); return $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), null, null) ? 'ok' : 'no'; }";
        let first = jxa(JS, Some(path));
        if first.as_deref().is_ok_and(|o| o == "ok") && fs::symlink_metadata(path).is_err() {
            return Ok(());
        }
        let s = Command::new(OSASCRIPT)
            .args(["-e", "on run argv", "-e", "set f to POSIX file (item 1 of argv)", "-e", "tell application \"Finder\" to delete f", "-e", "end run"])
            .arg(path)
            .status()?;
        if s.success() && fs::symlink_metadata(path).is_err() {
            Ok(())
        } else {
            Err(io::Error::other(format!("trash: {first:?}, Finder: {s}")))
        }
    }

    /// "Usar esta copia" for chalito://: registers this bundle, then asks LaunchServices to open
    /// the scheme with it by path (macOS 12+); the caller checks the result.
    pub fn claim_handler(bundle: &Path) -> io::Result<()> {
        let s = Command::new(LSREGISTER).arg("-f").arg(bundle).status()?;
        if !s.success() {
            eprintln!("copies: lsregister -f: {s}");
        }
        const JS: &str = "function run(argv) { ObjC.import('AppKit'); var ws = $.NSWorkspace.sharedWorkspace; if (!ws.respondsToSelector('setDefaultApplicationAtURL:toOpenURLsWithScheme:completionHandler:')) return 'old'; ws.setDefaultApplicationAtURLToOpenURLsWithSchemeCompletionHandler($.NSURL.fileURLWithPath(argv[0]), 'chalito', null); delay(1); return 'ok'; }";
        jxa(JS, Some(bundle)).map(|_| ())
    }

    /// "Mover a Aplicaciones": opens Applications, and from a DMG shows the app to drag there.
    pub fn show_applications(bundle: Option<&Path>, placement: Placement) -> io::Result<()> {
        if let (Some(b), Placement::Dmg) = (bundle, placement) {
            Command::new("/usr/bin/open").arg("-R").arg(b).status()?;
        }
        let s = Command::new("/usr/bin/open").arg("/Applications").status()?;
        if s.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!("open: {s}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: &str, version: &str) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n  <key>CFBundleExecutable</key>\n  <string>chalito-desktop</string>\n  <key>CFBundleIdentifier</key>\n  <string>{id}</string>\n  <key>CFBundleShortVersionString</key>\n  <string>{version}</string>\n</dict>\n</plist>\n"
        )
    }

    #[test]
    fn plist_values_and_the_launch_agent_program_are_read() {
        let xml = info("com.chalyb.chalito", "0.1.0-beta.2");
        assert_eq!(plist_string(&xml, "CFBundleIdentifier").as_deref(), Some("com.chalyb.chalito"));
        assert_eq!(plist_string(&xml, "CFBundleShortVersionString").as_deref(), Some("0.1.0-beta.2"));
        assert_eq!(plist_string(&xml, "CFBundleName"), None);
        // auto-launch's LaunchAgent, as it writes it (paths unescaped there; escaped ones read too).
        let agent = "<?xml version=\"1.0\"?>\n<plist version=\"1.0\">\n  <dict>\n  <key>Label</key>\n  <string>Chalito</string>\n  <key>AssociatedBundleIdentifiers</key>\n  <array></array>\n  <key>ProgramArguments</key>\n  <array><string>/Users/ana/Downloads/Chalito &amp; co.app/Contents/MacOS/chalito-desktop</string></array>\n  <key>RunAtLoad</key>\n  <true/>\n  </dict>\n</plist>";
        assert_eq!(agent_program(agent), Some(PathBuf::from("/Users/ana/Downloads/Chalito & co.app/Contents/MacOS/chalito-desktop")));
        assert_eq!(agent_program("<plist><dict><key>ProgramArguments</key><array></array></dict></plist>"), None);
        assert_eq!(agent_program("<plist/>"), None);
    }

    #[test]
    fn the_bundle_and_where_it_runs_from() {
        let exe = Path::new("/Applications/Chalito.app/Contents/MacOS/chalito-desktop");
        assert_eq!(bundle_of(exe), Some(PathBuf::from("/Applications/Chalito.app")));
        assert_eq!(bundle_of(Path::new("/usr/local/bin/chalito-desktop")), None);
        assert_eq!(placement(Path::new("/Applications/Chalito.app"), false), Placement::Ok);
        assert_eq!(placement(Path::new("/Volumes/Chalito 0.1.0/Chalito.app"), true), Placement::Dmg);
        // An app installed on an external drive is fine where it is.
        assert_eq!(placement(Path::new("/Volumes/External/Applications/Chalito.app"), false), Placement::Ok);
        let moved = Path::new("/private/var/folders/xy/abc/T/AppTranslocation/1A2B-3C4D/d/Chalito.app");
        assert_eq!(placement(moved, true), Placement::Translocated);
    }

    #[test]
    fn dmg_names_are_recognised() {
        for yes in ["Chalito_0.1.0_universal.dmg", "UNSIGNED_Chalito_0.1.0-beta.2_aarch64.DMG", "chalito.dmg"] {
            assert!(is_chalito_dmg(yes), "{yes}");
        }
        for no in ["Chalito.dmg.download", "Cursor.dmg", "Chalito.app", ".dmg"] {
            assert!(!is_chalito_dmg(no), "{no}");
        }
        assert_eq!(copies::version_from_name("UNSIGNED_Chalito_0.1.0-beta.2_aarch64.dmg").as_deref(), Some("0.1.0-beta.2"));
        assert_eq!(copies::version_from_name("Chalito_0.1.0_universal.dmg").as_deref(), Some("0.1.0"));
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("chalito-mac-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn app(at: &Path, id: &str, version: &str) -> PathBuf {
        fs::create_dir_all(at.join("Contents/MacOS")).unwrap();
        fs::write(at.join("Contents/Info.plist"), info(id, version)).unwrap();
        fs::write(at.join("Contents/MacOS/chalito-desktop"), b"").unwrap();
        at.to_path_buf()
    }

    /// Fake bundles in temp folders: the scan by bundle id, the LaunchAgent and handler checks,
    /// then the trash guard.
    #[test]
    fn other_bundles_are_found_by_their_id_and_the_guard_protects_ours() {
        let d = tmp("scan");
        let home = d.join("home");
        let apps = d.join("Applications");
        let running = app(&apps.join("Chalito.app"), BUNDLE_ID, "0.2.0");
        let exe = running.join("Contents/MacOS/chalito-desktop");
        let old = app(&home.join("Downloads/Chalito 2.app"), BUNDLE_ID, "0.1.0-beta.2");
        let nested = app(&apps.join("Chalyb/Chalito.app"), BUNDLE_ID, "0.1.0");
        let user = app(&home.join("Applications/Chalito.app"), BUNDLE_ID, "0.1.5");
        app(&home.join("Downloads/Cursor.app"), "com.todesktop.cursor", "1.0");
        app(&home.join("Desktop/Fake Chalito.app"), "com.example.chalito", "9.9");
        let deep = app(&apps.join("a/b/Chalito.app"), BUNDLE_ID, "0.0.1");
        let dmg = home.join("Downloads/Chalito_0.1.0_universal.dmg");
        fs::write(&dmg, b"koly").unwrap();
        fs::write(home.join("Downloads/Cursor.dmg"), b"").unwrap();
        fs::write(home.join("Desktop/Chalito-notes.txt"), b"").unwrap();
        fs::create_dir_all(home.join("Library/LaunchAgents")).unwrap();

        let agent = |p: &Path| format!("<plist><dict><key>ProgramArguments</key><array><string>{}</string></array></dict></plist>", p.display());
        let i = Inputs {
            running: exe.clone(),
            applications: apps.clone(),
            home: home.clone(),
            downloads: Some(home.join("Downloads")),
            desktop: Some(home.join("Desktop")),
            agent: Some(agent(&old.join("Contents/MacOS/chalito-desktop"))),
            handler: Some(running.clone()),
            read_only: false,
        };
        let r = report(&i);
        assert_eq!(r.running, running.display().to_string());
        assert_eq!(r.placement, Placement::Ok);
        assert_eq!(r.autostart, Link::Other { path: old.join("Contents/MacOS/chalito-desktop").display().to_string() });
        assert_eq!(r.handler, Link::Ours);
        let mut got: Vec<(PathBuf, CopyKind)> = r.copies.iter().map(|c| (PathBuf::from(&c.path), c.kind)).collect();
        got.sort();
        let mut want = vec![(old.clone(), CopyKind::App), (nested.clone(), CopyKind::App), (user.clone(), CopyKind::App), (dmg.clone(), CopyKind::Dmg)];
        want.sort();
        assert_eq!(got, want);
        assert!(!got.iter().any(|(p, _)| p == &deep || p == &running));
        let v = |p: &Path| r.copies.iter().find(|c| Path::new(&c.path) == p).and_then(|c| c.version.clone());
        assert_eq!(v(&old).as_deref(), Some("0.1.0-beta.2"));
        assert_eq!(v(&dmg).as_deref(), Some("0.1.0"));

        // The LaunchAgent and the handler on this copy; the handler on a bundle that's gone.
        let ours = Inputs { agent: Some(agent(&exe)), handler: Some(d.join("gone/Chalito.app")), ..i };
        let r2 = report(&ours);
        assert_eq!(r2.autostart, Link::Ours);
        assert_eq!(r2.handler, Link::Gone { path: d.join("gone/Chalito.app").display().to_string() });

        assert_eq!(copies::may_trash(&old, &exe, &r.copies), Ok(()));
        assert_eq!(copies::may_trash(&dmg, &exe, &r.copies), Ok(()));
        assert_eq!(copies::may_trash(&running, &exe, &r.copies), Err(copies::Refusal::Running));
        assert_eq!(copies::may_trash(&apps, &exe, &r.copies), Err(copies::Refusal::Running));
        assert_eq!(copies::may_trash(&home.join("Downloads/Cursor.app"), &exe, &r.copies), Err(copies::Refusal::NotACopy));
        let notes = home.join("Desktop/Chalito-notes.txt");
        let forged = vec![OldCopy { path: notes.display().to_string(), kind: CopyKind::Dmg, ..OldCopy::default() }];
        assert_eq!(copies::may_trash(&notes, &exe, &forged), Err(copies::Refusal::NotACopy));
        #[cfg(unix)]
        {
            let link = home.join("Downloads/Linked.app");
            std::os::unix::fs::symlink(&old, &link).unwrap();
            let listed = vec![OldCopy { path: link.display().to_string(), kind: CopyKind::App, ..OldCopy::default() }];
            assert_eq!(copies::may_trash(&link, &exe, &listed), Err(copies::Refusal::NotACopy));
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn from_a_dmg_or_translocated_the_identical_bundle_is_never_offered_for_the_trash() {
        let d = tmp("placement");
        let home = d.join("home");
        let apps = d.join("Applications");
        // The running copy, mirrored at a translocation-style path; its original sits in Downloads.
        let running = app(&d.join("AppTranslocation/1A2B/d/Chalito.app"), BUNDLE_ID, "0.2.0");
        let original = app(&home.join("Downloads/Chalito.app"), BUNDLE_ID, "0.2.0");
        let older = app(&apps.join("Chalito.app"), BUNDLE_ID, "0.1.0");
        let i = Inputs {
            running: running.join("Contents/MacOS/chalito-desktop"),
            applications: apps,
            home: home.clone(),
            downloads: Some(home.join("Downloads")),
            read_only: true,
            ..Inputs::default()
        };
        let r = report(&i);
        assert_eq!(r.placement, Placement::Translocated);
        let paths: Vec<PathBuf> = r.copies.iter().map(|c| PathBuf::from(&c.path)).collect();
        assert_eq!(paths, vec![older]);
        assert!(!paths.contains(&original));
        let _ = fs::remove_dir_all(&d);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn on_macos_a_binary_plist_is_read_and_a_dmg_goes_to_the_trash() {
        let d = tmp("real");
        let b = app(&d.join("Chalito.app"), BUNDLE_ID, "0.3.0");
        let plist = b.join("Contents/Info.plist");
        let s = std::process::Command::new("/usr/bin/plutil").args(["-convert", "binary1"]).arg(&plist).status().unwrap();
        assert!(s.success());
        assert!(fs::read(&plist).unwrap().starts_with(b"bplist"));
        assert_eq!(bundle_version(&b), Some(Some("0.3.0".into())));
        // The real NSFileManager trash, on a throwaway file.
        let dmg = d.join("Chalito_0.0.1_test.dmg");
        fs::write(&dmg, b"x").unwrap();
        os::trash(&dmg).unwrap();
        assert!(!dmg.exists());
        // The handler lookup runs (on a runner nothing may own chalito://).
        let _ = os::handler();
        assert!(!os::read_only(&d));
        let _ = fs::remove_dir_all(&d);
    }
}
