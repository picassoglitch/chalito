//! The panel's way to the local agent (apps/agent/src/ipc-server.ts): one JSON line out, one
//! back, over `~/.chalito/agent.sock` (a per-user named pipe on Windows), with the per-launch
//! secret this app gave the agent it started. Never a TCP port.
//!
//! No Tauri types here, so it's unit-tested against a fake agent on a real socket.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

/// Every failure to reach the agent maps to this code; the panel shows "the agent isn't answering".
pub const UNAVAILABLE: &str = "agent_ipc_unavailable";
const MAX_REPLY: usize = 1024 * 1024;

/// Must match `ipcPath` in apps/agent/src/ipc-server.ts.
pub fn socket_path(home: &Path) -> PathBuf {
    if cfg!(windows) {
        let user: String = std::env::var("USERNAME")
            .unwrap_or_default()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
            .take(64)
            .collect();
        PathBuf::from(format!(r"\\.\pipe\chalito-agent-{}", if user.is_empty() { "user" } else { &user }))
    } else {
        home.join(".chalito").join("agent.sock")
    }
}

/// 128+ random bits as hex, made once per app launch and handed to the agent on stdin.
pub fn new_secret() -> Result<String, getrandom::Error> {
    let mut b = [0u8; 32];
    getrandom::getrandom(&mut b)?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Enabling Developer mode waits for the person at the OS prompt; everything else is quick.
#[cfg_attr(windows, allow(dead_code))] // a named-pipe file handle has no read timeout
pub fn timeout_for(method: &str) -> Duration {
    if method == "enableDevToggle" {
        Duration::from_secs(300)
    } else {
        Duration::from_secs(15)
    }
}

/// Turns the agent's reply line into the result, or its error code.
pub fn parse_reply(line: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(line).map_err(|_| UNAVAILABLE.to_string())?;
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(v.get("result").cloned().unwrap_or(Value::Null));
    }
    let code = v.get("error").and_then(Value::as_str).unwrap_or("internal");
    // A wrong secret means this isn't the agent we started (e.g. the OS service's).
    Err(if code == "unauthorized" { UNAVAILABLE.to_string() } else { code.to_string() })
}

pub fn request(token: &str, method: &str, params: &Value) -> String {
    format!("{}\n", json!({ "id": 1, "token": token, "method": method, "params": params }))
}

fn exchange<S: std::io::Read + Write>(stream: S, line: &str) -> Result<Value, String> {
    let mut stream = stream;
    stream.write_all(line.as_bytes()).map_err(|_| UNAVAILABLE.to_string())?;
    stream.flush().map_err(|_| UNAVAILABLE.to_string())?;
    let mut reply = String::new();
    BufReader::new(stream.take(MAX_REPLY as u64))
        .read_line(&mut reply)
        .map_err(|_| UNAVAILABLE.to_string())?;
    if reply.is_empty() {
        return Err(UNAVAILABLE.to_string());
    }
    parse_reply(reply.trim_end())
}

pub fn call(path: &Path, token: &str, method: &str, params: &Value) -> Result<Value, String> {
    let line = request(token, method, params);
    #[cfg(unix)]
    {
        let s = std::os::unix::net::UnixStream::connect(path).map_err(|_| UNAVAILABLE.to_string())?;
        let t = Some(timeout_for(method));
        s.set_read_timeout(t).map_err(|_| UNAVAILABLE.to_string())?;
        s.set_write_timeout(Some(Duration::from_secs(5))).map_err(|_| UNAVAILABLE.to_string())?;
        exchange(s, &line)
    }
    #[cfg(windows)]
    {
        // Node's named pipe server is byte-mode: a plain read/write file handle works.
        let f = std::fs::OpenOptions::new().read(true).write(true).open(path).map_err(|_| UNAVAILABLE.to_string())?;
        exchange(f, &line)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn fake_agent(name: &str, reply: &'static str) -> (PathBuf, std::thread::JoinHandle<String>) {
        let dir = std::env::temp_dir().join(format!("chalito-ipc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut line = String::new();
            BufReader::new(s.try_clone().unwrap()).read_line(&mut line).unwrap();
            s.write_all(reply.as_bytes()).unwrap();
            line
        });
        (path, h)
    }

    #[test]
    fn sends_the_secret_and_returns_the_result() {
        let (path, h) = fake_agent("ok", "{\"id\":1,\"ok\":true,\"result\":{\"version\":\"0.0.0\"}}\n");
        let r = call(&path, "s3cret", "ping", &Value::Null).unwrap();
        assert_eq!(r, json!({ "version": "0.0.0" }));
        let sent: Value = serde_json::from_str(&h.join().unwrap()).unwrap();
        assert_eq!(sent, json!({ "id": 1, "token": "s3cret", "method": "ping", "params": null }));
    }

    #[test]
    fn errors_are_codes_and_a_foreign_agent_reads_as_unavailable() {
        let (path, h) = fake_agent("err", "{\"id\":1,\"ok\":false,\"error\":\"no_pending_pairing\"}\n");
        assert_eq!(call(&path, "t", "confirmPairing", &json!({})), Err("no_pending_pairing".into()));
        h.join().unwrap();
        let (path, h) = fake_agent("unauth", "{\"id\":1,\"ok\":false,\"error\":\"unauthorized\"}\n");
        assert_eq!(call(&path, "t", "ping", &Value::Null), Err(UNAVAILABLE.into()));
        h.join().unwrap();
    }

    #[test]
    fn no_agent_listening_is_unavailable() {
        let missing = std::env::temp_dir().join("chalito-ipc-nobody.sock");
        assert_eq!(call(&missing, "t", "ping", &Value::Null), Err(UNAVAILABLE.into()));
        assert_eq!(parse_reply("garbage"), Err(UNAVAILABLE.into()));
    }

    #[test]
    fn secrets_are_fresh_hex_and_paths_match_the_agent() {
        let a = new_secret().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, new_secret().unwrap());
        assert_eq!(socket_path(Path::new("/home/ana")), PathBuf::from("/home/ana/.chalito/agent.sock"));
        assert_eq!(timeout_for("enableDevToggle"), Duration::from_secs(300));
    }
}
