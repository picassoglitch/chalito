//! The LCD board over USB serial (docs/BOARD_LINK.md). ESP-IDF logs share the port, so only
//! JSON object lines with a `type` reach the windows.

use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serialport::{SerialPort, SerialPortType};

/// Espressif's USB Serial/JTAG (ESP32-C6).
pub const VID: u16 = 0x303a;
pub const PID: u16 = 0x1001;
/// BOARD_LINK: at most this many bytes a line, newline excluded.
pub const MAX_LINE: usize = 4096;

const SCAN: Duration = Duration::from_secs(2);
/// After a refused open (permissions, busy): retried quietly this often.
const RETRY: Duration = Duration::from_secs(5);

pub const EVENT_LINE: &str = "board://line";
pub const EVENT_STATUS: &str = "board://status";

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum BoardStatus {
    /// No board plugged in.
    Absent,
    Connected {
        port: String,
    },
    /// The OS refused the port (Linux: the user isn't in `dialout`).
    Permission {
        port: String,
    },
    Error {
        port: String,
        message: String,
    },
}

/// Where the link reports to: the windows in the app, a channel in tests.
pub trait Sink: Send + Sync + 'static {
    fn status(&self, status: &BoardStatus);
    fn line(&self, line: &str);
}

#[derive(Default)]
struct Inner {
    writer: Option<Box<dyn SerialPort>>,
    status: Option<BoardStatus>,
}

/// The one connection to the board, shared by the reader thread and the write command.
#[derive(Default, Clone)]
pub struct Board(Arc<Mutex<Inner>>);

impl Board {
    pub fn status(&self) -> BoardStatus {
        self.0
            .lock()
            .ok()
            .and_then(|i| i.status.clone())
            .unwrap_or(BoardStatus::Absent)
    }

    /// Reports a status only when it changes, so a refused port doesn't repeat every retry.
    fn set_status(&self, sink: &dyn Sink, status: BoardStatus) {
        let changed = match self.0.lock() {
            Ok(mut i) if i.status.as_ref() != Some(&status) => {
                i.status = Some(status.clone());
                true
            }
            _ => false,
        };
        if changed {
            match &status {
                BoardStatus::Permission { port } => {
                    eprintln!("board: no permission to open {port} (Linux: add your user to the dialout group)")
                }
                BoardStatus::Error { port, message } => eprintln!("board: {port}: {message}"),
                _ => {}
            }
            sink.status(&status);
        }
    }

    /// One look for the board (`CHALITO_BOARD_PORT` aside): a listing error is a status, not an absent board.
    fn scan(&self, sink: &dyn Sink, listed: serialport::Result<Vec<serialport::SerialPortInfo>>) -> Option<String> {
        match listed {
            Ok(ports) => {
                let found = find_port(ports);
                if found.is_none() {
                    self.set_status(sink, BoardStatus::Absent);
                }
                found
            }
            Err(e) => {
                self.set_status(
                    sink,
                    BoardStatus::Error {
                        port: "USB".into(),
                        message: e.to_string(),
                    },
                );
                None
            }
        }
    }

    /// Writes one JSON line to the board.
    pub fn write_line(&self, line: &str) -> Result<(), String> {
        check_outgoing(line)?;
        let mut i = self.0.lock().map_err(|_| "board link poisoned".to_string())?;
        let w = i.writer.as_mut().ok_or_else(|| "board not connected".to_string())?;
        let mut buf = Vec::with_capacity(line.len() + 1);
        buf.extend_from_slice(line.as_bytes());
        buf.push(b'\n');
        w.write_all(&buf)
            .and_then(|_| w.flush())
            .map_err(|e| format!("board write failed: {e}"))
    }

    /// Runs one open port until it fails (unplugged): lines go to `sink`, writes go through it.
    pub fn serve(&self, sink: &dyn Sink, port_name: &str, port: Box<dyn SerialPort>) {
        self.serve_with(sink, port_name, port, port_listed);
    }

    fn serve_with(
        &self,
        sink: &dyn Sink,
        port_name: &str,
        mut port: Box<dyn SerialPort>,
        listed: impl Fn(&str) -> bool,
    ) {
        let writer = match port.try_clone() {
            Ok(w) => w,
            Err(e) => {
                self.set_status(
                    sink,
                    BoardStatus::Error {
                        port: port_name.into(),
                        message: e.to_string(),
                    },
                );
                return;
            }
        };
        if let Ok(mut i) = self.0.lock() {
            i.writer = Some(writer);
        }
        self.set_status(sink, BoardStatus::Connected { port: port_name.into() });
        let err = pump(&mut port, |l| sink.line(l));
        eprintln!("board: reading {port_name} stopped: {err}");
        if let Ok(mut i) = self.0.lock() {
            i.writer = None;
        }
        // The device node outlives the unplug by a moment; still there after that, the port broke.
        thread::sleep(Duration::from_millis(300));
        let status = if listed(port_name) {
            BoardStatus::Error {
                port: port_name.into(),
                message: err.to_string(),
            }
        } else {
            BoardStatus::Absent
        };
        self.set_status(sink, status);
    }

    /// Finds, opens and serves the board forever, on its own thread.
    pub fn spawn(&self, sink: impl Sink) {
        let board = self.clone();
        thread::spawn(move || loop {
            let found = match std::env::var("CHALITO_BOARD_PORT") {
                Ok(p) => (!p.is_empty()).then_some(p),
                Err(_) => board.scan(&sink, serialport::available_ports()),
            };
            let Some(name) = found else {
                thread::sleep(SCAN);
                continue;
            };
            match open(&name) {
                Ok(port) => {
                    board.serve(&sink, &name, port);
                    thread::sleep(Duration::from_millis(500));
                }
                Err(e) => {
                    let status = if is_permission(&e) {
                        BoardStatus::Permission { port: name }
                    } else {
                        BoardStatus::Error {
                            port: name,
                            message: e.to_string(),
                        }
                    };
                    board.set_status(&sink, status);
                    thread::sleep(RETRY);
                }
            }
        });
    }
}

fn is_permission(e: &serialport::Error) -> bool {
    matches!(e.kind(), serialport::ErrorKind::Io(io::ErrorKind::PermissionDenied))
        || e.to_string().to_lowercase().contains("permission denied")
}

fn open(name: &str) -> serialport::Result<Box<dyn SerialPort>> {
    // DTR on and RTS off: the USB Serial/JTAG resets the chip on some DTR/RTS combinations.
    let mut port = serialport::new(name, 115_200)
        .timeout(Duration::from_millis(200))
        .dtr_on_open(true)
        .open()?;
    let _ = port.write_request_to_send(false);
    Ok(port)
}

fn port_listed(name: &str) -> bool {
    if std::env::var("CHALITO_BOARD_PORT").is_ok_and(|p| p == name) {
        return std::path::Path::new(name).exists();
    }
    serialport::available_ports().is_ok_and(|ps| ps.iter().any(|p| p.port_name == name))
}

/// The board's port among `ports` (the first VID/PID match), or None.
fn find_port(ports: Vec<serialport::SerialPortInfo>) -> Option<String> {
    let mut matches: Vec<String> = ports
        .into_iter()
        .filter(|p| matches!(&p.port_type, SerialPortType::UsbPort(u) if u.vid == VID && u.pid == PID))
        .map(|p| p.port_name)
        .collect();
    // macOS lists both; the call-out device doesn't wait for carrier detect.
    matches.sort_by_key(|n| !n.starts_with("/dev/cu."));
    matches.into_iter().next()
}

fn check_outgoing(line: &str) -> Result<(), String> {
    if line.len() > MAX_LINE || line.contains(['\n', '\r']) {
        return Err("board line too long or not a single line".into());
    }
    if !is_message(line) {
        return Err("board line must be a JSON object with a type".into());
    }
    Ok(())
}

/// A board message: a JSON object with a string `type`. Anything else is log output.
pub fn is_message(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('{')
        && serde_json::from_str::<serde_json::Value>(t)
            .ok()
            .is_some_and(|v| v.get("type").is_some_and(|t| t.is_string()))
}

/// Splits a byte stream into lines of at most MAX_LINE bytes; longer ones are dropped whole.
#[derive(Default)]
pub struct Lines {
    buf: Vec<u8>,
    overlong: bool,
}

impl Lines {
    pub fn push(&mut self, bytes: &[u8], mut out: impl FnMut(&str)) {
        for &b in bytes {
            if b == b'\n' {
                if !self.overlong {
                    let end = if self.buf.last() == Some(&b'\r') {
                        self.buf.len() - 1
                    } else {
                        self.buf.len()
                    };
                    if end <= MAX_LINE {
                        if let Ok(s) = std::str::from_utf8(&self.buf[..end]) {
                            out(s);
                        }
                    }
                }
                self.buf.clear();
                self.overlong = false;
            } else if !self.overlong {
                // Room for MAX_LINE bytes and a trailing \r; the content check is at the newline.
                if self.buf.len() > MAX_LINE {
                    self.overlong = true;
                    self.buf.clear();
                } else {
                    self.buf.push(b);
                }
            }
        }
    }
}

/// Reads until the port fails, handing on the message lines. Timeouts are not failures.
pub fn pump(port: &mut dyn Read, mut on_line: impl FnMut(&str)) -> io::Error {
    let mut lines = Lines::default();
    let mut chunk = [0u8; 1024];
    loop {
        match port.read(&mut chunk) {
            Ok(0) => return io::Error::new(io::ErrorKind::UnexpectedEof, "board closed"),
            Ok(n) => lines.push(&chunk[..n], |l| {
                if is_message(l) {
                    on_line(l.trim())
                }
            }),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) => {}
            Err(e) => return e,
        }
    }
}

/// Reports to every window as events.
pub struct TauriSink(pub tauri::AppHandle);

impl Sink for TauriSink {
    fn status(&self, status: &BoardStatus) {
        use tauri::Emitter;
        let _ = self.0.emit(EVENT_STATUS, status);
    }
    fn line(&self, line: &str) {
        use tauri::Emitter;
        let _ = self.0.emit(EVENT_LINE, line);
    }
}

#[tauri::command]
pub fn board_status(board: tauri::State<'_, Board>) -> BoardStatus {
    board.status()
}

#[tauri::command]
pub fn board_write(board: tauri::State<'_, Board>, line: String) -> Result<(), String> {
    board.write_line(&line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    struct Chan(Mutex<mpsc::Sender<String>>);
    impl Sink for Chan {
        fn status(&self, s: &BoardStatus) {
            let _ = self
                .0
                .lock()
                .unwrap()
                .send(format!("status:{}", serde_json::to_string(s).unwrap()));
        }
        fn line(&self, l: &str) {
            let _ = self.0.lock().unwrap().send(format!("line:{l}"));
        }
    }

    #[test]
    fn lines_split_trim_cr_and_drop_overlong() {
        let mut got = vec![];
        let mut l = Lines::default();
        l.push(b"a\r\nb", |s| got.push(s.to_string()));
        l.push(b"c\n", |s| got.push(s.to_string()));
        let long = vec![b'x'; MAX_LINE + 10];
        l.push(&long, |s| got.push(s.to_string()));
        l.push(b"\nok\n", |s| got.push(s.to_string()));
        assert_eq!(got, ["a", "bc", "ok"]);
    }

    #[test]
    fn only_json_messages_count() {
        assert!(is_message(r#"{"v":1,"type":"hello"}"#));
        assert!(!is_message("I (123) main: booting"));
        assert!(!is_message(r#"{"v":1}"#));
        assert!(!is_message("{not json"));
        assert!(check_outgoing(r#"{"v":1,"type":"hello"}"#).is_ok());
        assert!(check_outgoing("{\"type\":\"a\"}\n{\"type\":\"b\"}").is_err());
        assert!(check_outgoing(&format!(r#"{{"type":"x","d":"{}"}}"#, "a".repeat(MAX_LINE))).is_err());
    }

    #[test]
    fn writes_without_a_board_fail_quietly() {
        assert_eq!(
            Board::default().write_line(r#"{"v":1,"type":"hello"}"#).unwrap_err(),
            "board not connected"
        );
        assert_eq!(Board::default().status(), BoardStatus::Absent);
    }

    #[test]
    fn line_limit_is_exact() {
        let mut got = vec![];
        let mut l = Lines::default();
        let max = "x".repeat(MAX_LINE);
        l.push(format!("{max}\n{max}\r\n{max}y\nok\n").as_bytes(), |s| got.push(s.len()));
        assert_eq!(got, [MAX_LINE, MAX_LINE, 2]);
    }

    #[test]
    fn a_port_listing_error_is_reported_once() {
        let (tx, rx) = mpsc::channel();
        let sink = Chan(Mutex::new(tx));
        let board = Board::default();
        let err = || Err(serialport::Error::new(serialport::ErrorKind::Unknown, "udev gone"));
        assert_eq!(board.scan(&sink, err()), None);
        assert_eq!(board.scan(&sink, err()), None);
        let got: Vec<String> = rx.try_iter().collect();
        assert_eq!(got, [r#"status:{"state":"error","port":"USB","message":"udev gone"}"#]);
        assert_eq!(board.scan(&sink, Ok(vec![])), None);
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), [r#"status:{"state":"absent"}"#]);
    }

    /// A read error on a port the OS still lists is not an unplug.
    #[cfg(unix)]
    #[test]
    fn a_read_error_on_a_listed_port_is_an_error_not_absent() {
        use serialport::TTYPort;
        let (fake, ours) = TTYPort::pair().expect("pty");
        let (tx, rx) = mpsc::channel();
        let sink = Chan(Mutex::new(tx));
        let board = Board::default();
        let b2 = board.clone();
        let t = thread::spawn(move || {
            let mut ours = ours;
            ours.set_timeout(Duration::from_millis(50)).unwrap();
            b2.serve_with(&sink, "pty", Box::new(ours), |_| true);
        });
        let recv = || rx.recv_timeout(Duration::from_secs(5)).expect("event");
        assert_eq!(recv(), r#"status:{"state":"connected","port":"pty"}"#);
        drop(fake);
        let s = recv();
        assert!(s.starts_with(r#"status:{"state":"error","port":"pty","message":"#), "{s}");
        t.join().unwrap();
    }

    /// A pty stands in for the board: logs are skipped, writes arrive, and closing it is an unplug.
    #[cfg(unix)]
    #[test]
    fn serves_a_pty_board_until_it_goes_away() {
        use serialport::TTYPort;
        let (mut fake, ours) = TTYPort::pair().expect("pty");
        let (tx, rx) = mpsc::channel();
        let sink = Chan(Mutex::new(tx));
        let board = Board::default();
        let b2 = board.clone();
        let t = thread::spawn(move || {
            let mut ours = ours;
            ours.set_timeout(Duration::from_millis(50)).unwrap();
            b2.serve(&sink, "pty", Box::new(ours));
        });
        let recv = || rx.recv_timeout(Duration::from_secs(5)).expect("event");
        assert_eq!(recv(), r#"status:{"state":"connected","port":"pty"}"#);
        fake.write_all(b"I (42) boot: ESP-IDF\r\n{\"v\":1,\"type\":\"hello\",\"card\":null}\r\n")
            .unwrap();
        assert_eq!(recv(), r#"line:{"v":1,"type":"hello","card":null}"#);

        board.write_line(r#"{"v":1,"type":"hello"}"#).unwrap();
        fake.set_timeout(Duration::from_secs(5)).unwrap();
        let mut got = vec![0u8; 23];
        fake.read_exact(&mut got).unwrap();
        assert_eq!(got, b"{\"v\":1,\"type\":\"hello\"}\n");

        drop(fake);
        assert_eq!(recv(), r#"status:{"state":"absent"}"#);
        t.join().unwrap();
        assert!(board.write_line(r#"{"v":1,"type":"hello"}"#).is_err());
    }
}
