//! Runs the bundled agent (`chalito-agent run`, ADR 0004, D-061) while the app is open.
//!
//! Release builds ship the agent as a sidecar next to the app's own binary. The supervisor
//! starts it once this computer is paired (`~/.chalito/config.json` names an owner and a
//! device; the agent itself checks the signature), and before that only to serve the panel's
//! "Conectar esta computadora" (ADR 0028 §3; the agent exits once paired and is started again
//! as the real agent). It restarts it with backoff when it crashes,
//! and stops it when the app quits. It never starts a second agent: `chalito run` exits 75
//! when one is already running (e.g. the OS service), and 78 when a setup step is missing
//! (Claude Code not pinned), in which case it waits for the config to change.
//!
//! No Tauri types here, so the logic is unit-tested on its own.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

/// `chalito run` exit codes (apps/agent/src/instance-lock.ts).
pub const EXIT_ALREADY_RUNNING: i32 = 75;
pub const EXIT_NEEDS_SETUP: i32 = 78;

const SIDECAR: &str = "chalito-agent";
const UNPAIRED_POLL: Duration = Duration::from_secs(10);
const SETUP_POLL: Duration = Duration::from_secs(5);
const SETUP_MAX_WAIT: Duration = Duration::from_secs(300);
const ELSEWHERE_WAIT: Duration = Duration::from_secs(60);
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_secs(5);
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// A run at least this long counts as healthy: the next crash starts the backoff over.
pub const HEALTHY_RUN: Duration = Duration::from_secs(60);
pub const MAX_BACKOFF: Duration = Duration::from_secs(300);

/// What the panel shows (camelCase JSON for the webview).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Status {
    /// Dev and unwired builds: there is no bundled agent.
    NoSidecar,
    NotPaired,
    Running { pid: u32 },
    /// Crashed; the next start is in `retry_in_ms`.
    Restarting { exit_code: Option<i32>, retry_in_ms: u64 },
    /// `chalito run` exited 78: something to fix by hand (see the agent log or `chalito status`).
    NeedsSetup,
    /// Another agent (the OS service) already runs on this computer.
    Elsewhere,
    Stopped,
}

/// The sidecar sits next to the app's executable (Tauri strips the target triple when bundling).
pub fn sidecar_path(exe: &Path) -> Option<PathBuf> {
    let p = exe.parent()?.join(format!("{SIDECAR}{}", std::env::consts::EXE_SUFFIX));
    p.is_file().then_some(p)
}

pub fn config_path(home: &Path) -> PathBuf {
    home.join(".chalito").join("config.json")
}

/// Paired = the config names an owner and a device. The agent verifies the signature itself.
pub fn is_paired(home: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(config_path(home)) else { return false };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return false };
    let named = |k: &str| v.get(k).and_then(|x| x.as_str()).is_some_and(|s| !s.is_empty());
    named("owner") && named("deviceId")
}

/// 1 s, 2 s, 4 s… capped at MAX_BACKOFF.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(1u64 << attempt.min(16)).min(MAX_BACKOFF)
}

/// The public app config this build's panel was made with (release.yml, "Public app config"). The agent
/// needs the same api and Supabase to pair: it has no config file before that (2026-10-27: pairing failed).
const BUILT_WIRING: [(&str, Option<&str>); 3] = [
    ("CHALITO_API_BASE", option_env!("VITE_CHALITO_API_BASE")),
    ("SUPABASE_URL", option_env!("VITE_SUPABASE_URL")),
    ("SUPABASE_PUBLISHABLE_KEY", option_env!("VITE_SUPABASE_PUBLISHABLE_KEY")),
];

/// The variables to give the agent: all the built ones, or none when any endpoint is already set
/// (a local stack wins whole: its Supabase must not mix with the built api or key).
pub fn wiring_env(built: &[(&str, Option<&str>)], has: impl Fn(&str) -> bool) -> Vec<(String, String)> {
    if built.iter().any(|&(k, _)| has(k)) || has("SUPABASE_ANON_KEY") {
        return Vec::new();
    }
    built
        .iter()
        .filter_map(|&(k, v)| v.filter(|v| !v.is_empty()).map(|v| (k.to_string(), v.to_string())))
        .collect()
}

/// What the supervisor does after the agent exits.
#[derive(Debug, PartialEq, Eq)]
pub enum AfterExit {
    Restart(Duration),
    WaitForSetup,
    Elsewhere,
}

pub fn after_exit(code: Option<i32>, attempt: u32) -> AfterExit {
    match code {
        Some(EXIT_ALREADY_RUNNING) => AfterExit::Elsewhere,
        Some(EXIT_NEEDS_SETUP) => AfterExit::WaitForSetup,
        _ => AfterExit::Restart(backoff(attempt)),
    }
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Appends to `agent.log`, moving a large one to `agent.log.1` first.
fn open_log(dir: &Path) -> std::io::Result<File> {
    fs::create_dir_all(dir)?;
    let log = dir.join("agent.log");
    if fs::metadata(&log).is_ok_and(|m| m.len() > LOG_MAX_BYTES) {
        let _ = fs::rename(&log, dir.join("agent.log.1"));
    }
    OpenOptions::new().create(true).append(true).open(log)
}

struct Inner {
    /// The per-launch IPC secret given to the agent on stdin (ipc_client.rs).
    secret: Option<String>,
    status: Mutex<Status>,
    child: Mutex<Option<Child>>,
    quit: AtomicBool,
    /// Wakes the loop's sleeps early on quit.
    wake: (Mutex<()>, Condvar),
}

#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Inner>,
}

impl Supervisor {
    /// Starts the supervising thread. With no sidecar it only reports `NoSidecar`. `secret` is
    /// the panel's IPC secret, written as the agent's first stdin line (CHALITO_IPC=stdin).
    pub fn start(sidecar: Option<PathBuf>, home: PathBuf, log_dir: PathBuf, secret: Option<String>) -> Self {
        let initial = if sidecar.is_some() { Status::NotPaired } else { Status::NoSidecar };
        let s = Self {
            inner: Arc::new(Inner {
                secret,
                status: Mutex::new(initial),
                child: Mutex::new(None),
                quit: AtomicBool::new(false),
                wake: (Mutex::new(()), Condvar::new()),
            }),
        };
        if let Some(bin) = sidecar {
            let me = s.clone();
            std::thread::spawn(move || me.run(&bin, &home, &log_dir));
        }
        s
    }

    pub fn secret(&self) -> Option<&str> {
        self.inner.secret.as_deref()
    }

    pub fn status(&self) -> Status {
        self.inner.status.lock().map_or(Status::Stopped, |s| s.clone())
    }

    fn set(&self, st: Status) {
        if let Ok(mut s) = self.inner.status.lock() {
            *s = st;
        }
    }

    fn quitting(&self) -> bool {
        self.inner.quit.load(Ordering::SeqCst)
    }

    /// Sleeps up to `d`; returns early (true) when the app is quitting.
    fn sleep(&self, d: Duration) -> bool {
        let (m, cv) = &self.inner.wake;
        let Ok(g) = m.lock() else { return true };
        let _ = cv.wait_timeout_while(g, d, |_| !self.quitting());
        self.quitting()
    }

    fn run(&self, bin: &Path, home: &Path, log_dir: &Path) {
        let mut attempt = 0u32;
        while !self.quitting() {
            let paired = is_paired(home);
            // Before pairing the agent only runs when the panel can talk to it (it holds the secret).
            if !paired && self.inner.secret.is_none() {
                self.set(Status::NotPaired);
                if self.sleep(UNPAIRED_POLL) {
                    break;
                }
                continue;
            }
            // Not paired yet: `chalito run` serves only the panel's "Conectar esta computadora"
            // (apps/agent/src/pairing-host.ts) and exits once paired; the loop then starts it again
            // as the real agent. The panel keeps seeing `not_paired` meanwhile.
            let started = Instant::now();
            let code = match self.spawn_and_wait(bin, log_dir, !paired) {
                Ok(code) => code,
                Err(_) => None,
            };
            if self.quitting() {
                break;
            }
            if started.elapsed() >= HEALTHY_RUN {
                attempt = 0;
            }
            match after_exit(code, attempt) {
                AfterExit::Elsewhere => {
                    self.set(Status::Elsewhere);
                    if self.sleep(ELSEWHERE_WAIT) {
                        break;
                    }
                }
                AfterExit::WaitForSetup => {
                    self.set(Status::NeedsSetup);
                    let cfg = config_path(home);
                    let seen = mtime(&cfg);
                    let since = Instant::now();
                    while mtime(&cfg) == seen && since.elapsed() < SETUP_MAX_WAIT {
                        if self.sleep(SETUP_POLL) {
                            break;
                        }
                    }
                }
                AfterExit::Restart(d) => {
                    attempt = attempt.saturating_add(1);
                    self.set(if paired {
                        Status::Restarting { exit_code: code, retry_in_ms: d.as_millis() as u64 }
                    } else {
                        Status::NotPaired
                    });
                    if self.sleep(d) {
                        break;
                    }
                }
            }
        }
        self.set(Status::Stopped);
    }

    /// Runs `chalito-agent run` and waits for it; `None` when it was killed by a signal.
    fn spawn_and_wait(&self, bin: &Path, log_dir: &Path, pairing: bool) -> std::io::Result<Option<i32>> {
        let log = open_log(log_dir)?;
        let mut cmd = Command::new(bin);
        cmd.arg("run").stdout(log.try_clone()?).stderr(log);
        for (k, v) in wiring_env(&BUILT_WIRING, |k| std::env::var_os(k).is_some_and(|v| !v.is_empty())) {
            cmd.env(k, v);
        }
        if self.inner.secret.is_some() {
            cmd.env("CHALITO_IPC", "stdin").stdin(Stdio::piped());
        } else {
            cmd.stdin(Stdio::null());
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        // The secret travels on stdin (not argv or the environment, which other processes of
        // this user can read), then stdin closes.
        if let (Some(secret), Some(mut stdin)) = (self.inner.secret.as_deref(), child.stdin.take()) {
            use std::io::Write;
            let _ = stdin.write_all(format!("{secret}\n").as_bytes());
        }
        self.set(if pairing { Status::NotPaired } else { Status::Running { pid: child.id() } });
        if let Ok(mut c) = self.inner.child.lock() {
            *c = Some(child);
        }
        // stop() may have run before the child was stored: don't leave an orphan.
        if self.quitting() {
            if let Some(mut c) = self.inner.child.lock().ok().and_then(|mut c| c.take()) {
                terminate(&mut c);
            }
            return Ok(None);
        }
        loop {
            {
                let Ok(mut guard) = self.inner.child.lock() else { return Ok(None) };
                let Some(child) = guard.as_mut() else { return Ok(None) }; // taken by stop()
                if let Some(status) = child.try_wait()? {
                    *guard = None;
                    return Ok(status.code());
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    /// App quit: stop the loop, then ask the agent to stop (SIGTERM; it interrupts its sessions)
    /// and kill it if it hasn't after a few seconds.
    pub fn stop(&self) {
        self.inner.quit.store(true, Ordering::SeqCst);
        self.inner.wake.1.notify_all();
        let child = self.inner.child.lock().ok().and_then(|mut c| c.take());
        if let Some(mut child) = child {
            terminate(&mut child);
        }
        self.set(Status::Stopped);
    }
}

#[cfg(unix)]
fn terminate(child: &mut Child) {
    // SAFETY: kill(2) on our own child's pid; no memory is touched.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let until = Instant::now() + STOP_GRACE;
    while Instant::now() < until {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(unix))]
fn terminate(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("chalito-agent-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_agent_gets_the_wiring_it_was_built_with_unless_already_set() {
        let built = [("CHALITO_API_BASE", Some("https://api.example")), ("SUPABASE_URL", Some("")), ("SUPABASE_PUBLISHABLE_KEY", None)];
        assert_eq!(wiring_env(&built, |_| false), vec![("CHALITO_API_BASE".to_string(), "https://api.example".to_string())]);
        assert!(wiring_env(&built, |k| k == "CHALITO_API_BASE").is_empty());
    }

    #[test]
    fn a_local_stack_wins_whole_instead_of_mixing_with_the_built_wiring() {
        let built = [("CHALITO_API_BASE", Some("https://api.example")), ("SUPABASE_URL", Some("https://x.supabase.co"))];
        assert!(wiring_env(&built, |k| k == "SUPABASE_URL").is_empty());
        assert!(wiring_env(&built, |k| k == "SUPABASE_ANON_KEY").is_empty());
        assert_eq!(wiring_env(&built, |_| false).len(), 2);
    }

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff(0), Duration::from_secs(1));
        assert_eq!(backoff(3), Duration::from_secs(8));
        assert_eq!(backoff(9), MAX_BACKOFF);
        assert_eq!(backoff(u32::MAX), MAX_BACKOFF);
    }

    #[test]
    fn exit_codes_pick_the_next_step() {
        assert_eq!(after_exit(Some(EXIT_ALREADY_RUNNING), 0), AfterExit::Elsewhere);
        assert_eq!(after_exit(Some(EXIT_NEEDS_SETUP), 4), AfterExit::WaitForSetup);
        assert_eq!(after_exit(Some(1), 2), AfterExit::Restart(Duration::from_secs(4)));
        assert_eq!(after_exit(None, 0), AfterExit::Restart(Duration::from_secs(1)));
    }

    #[test]
    fn paired_needs_an_owner_and_a_device() {
        let home = tmp("paired");
        assert!(!is_paired(&home));
        fs::create_dir_all(home.join(".chalito")).unwrap();
        fs::write(config_path(&home), r#"{"apiBase":"https://api.test"}"#).unwrap();
        assert!(!is_paired(&home));
        fs::write(config_path(&home), r#"{"owner":"u1","deviceId":""}"#).unwrap();
        assert!(!is_paired(&home));
        fs::write(config_path(&home), "not json").unwrap();
        assert!(!is_paired(&home));
        fs::write(config_path(&home), r#"{"owner":"u1","deviceId":"d1","sig":"x"}"#).unwrap();
        assert!(is_paired(&home));
    }

    #[test]
    fn the_sidecar_is_next_to_the_app() {
        let dir = tmp("sidecar");
        let exe = dir.join("chalito-desktop");
        assert_eq!(sidecar_path(&exe), None);
        let bin = dir.join(format!("chalito-agent{}", std::env::consts::EXE_SUFFIX));
        fs::write(&bin, "").unwrap();
        assert_eq!(sidecar_path(&exe), Some(bin));
    }

    #[test]
    fn status_json_for_the_panel() {
        let j = |s: Status| serde_json::to_value(s).unwrap();
        assert_eq!(j(Status::NoSidecar), serde_json::json!({ "state": "no_sidecar" }));
        assert_eq!(j(Status::Running { pid: 7 }), serde_json::json!({ "state": "running", "pid": 7 }));
        assert_eq!(
            j(Status::Restarting { exit_code: Some(1), retry_in_ms: 2000 }),
            serde_json::json!({ "state": "restarting", "exitCode": 1, "retryInMs": 2000 })
        );
    }

    #[test]
    fn a_log_over_the_limit_is_rotated() {
        let dir = tmp("log");
        fs::write(dir.join("agent.log"), vec![b'x'; (LOG_MAX_BYTES + 1) as usize]).unwrap();
        drop(open_log(&dir).unwrap());
        assert!(dir.join("agent.log.1").exists());
        assert_eq!(fs::metadata(dir.join("agent.log")).unwrap().len(), 0);
    }

    /// The whole loop against a fake agent script: unpaired (the agent runs for the panel's
    /// pairing, then exits paired) → running → crash → restart; stop().
    #[cfg(unix)]
    #[test]
    fn supervises_a_fake_agent() {
        use std::os::unix::fs::PermissionsExt;
        let home = tmp("loop-home");
        let logs = tmp("loop-logs");
        let bin = home.join("chalito-agent");
        let cfg = config_path(&home);
        fs::write(home.join("paired.json"), r#"{"owner":"u1","deviceId":"d1"}"#).unwrap();
        // Counts its runs and records the stdin secret. Run 1 is the pairing host: it "pairs"
        // (writes config.json) and exits 0. Run 2 crashes (exit 1); later runs stay up until SIGTERM.
        let script = format!(
            "#!/bin/sh\nread s; echo \"$CHALITO_IPC $s\" > '{secret}'\necho run >> '{runs}'\nn=$(wc -l < '{runs}')\n\
             if [ $n -eq 1 ]; then sleep 0.4; mkdir -p '{dir}'; cp '{paired}' '{cfg}'; exit 0; fi\n\
             [ $n -eq 2 ] && exit 1\nwhile :; do sleep 0.1; done\n",
            secret = home.join("secret").display(),
            runs = home.join("runs").display(),
            dir = cfg.parent().unwrap().display(),
            paired = home.join("paired.json").display(),
            cfg = cfg.display(),
        );
        fs::write(&bin, script).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();

        let sup = Supervisor::start(Some(bin), home.clone(), logs, Some("ab".repeat(32)));
        std::thread::sleep(Duration::from_millis(150));
        // The pairing host is running, and the panel still sees "not paired".
        assert_eq!(sup.status(), Status::NotPaired);
        assert_eq!(fs::read_to_string(home.join("runs")).unwrap().lines().count(), 1);

        let until = Instant::now() + Duration::from_secs(20);
        let mut saw_restart = false;
        loop {
            match sup.status() {
                Status::Restarting { exit_code: Some(1), .. } => saw_restart = true,
                Status::Running { .. } if saw_restart => break,
                _ => {}
            }
            assert!(Instant::now() < until, "no restart: {:?}", sup.status());
            std::thread::sleep(Duration::from_millis(20));
        }
        // "Running" is set when the child starts, before the script records its run.
        let runs = || fs::read_to_string(home.join("runs")).map_or(0, |s| s.lines().count());
        let settle = Instant::now() + Duration::from_secs(5);
        while runs() < 3 && Instant::now() < settle {
            std::thread::sleep(Duration::from_millis(20));
        }
        sup.stop();
        assert_eq!(sup.status(), Status::Stopped);
        assert_eq!(runs(), 3);
        assert_eq!(fs::read_to_string(home.join("secret")).unwrap().trim(), format!("stdin {}", "ab".repeat(32)));
    }

    /// Without the panel's secret (no window to pair from) an unpaired computer runs nothing.
    #[cfg(unix)]
    #[test]
    fn without_the_secret_an_unpaired_computer_runs_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let home = tmp("nosecret-home");
        let bin = home.join("chalito-agent");
        fs::write(&bin, format!("#!/bin/sh\necho run >> '{}'\n", home.join("runs").display())).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let sup = Supervisor::start(Some(bin), home.clone(), tmp("nosecret-logs"), None);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(sup.status(), Status::NotPaired);
        assert!(!home.join("runs").exists());
        sup.stop();
    }
}
