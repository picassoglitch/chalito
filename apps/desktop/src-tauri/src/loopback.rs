//! DEVELOPMENT ONLY. Compiled only with `debug_assertions` (`tauri dev`, debug builds): the
//! `chalito://` scheme is registered only by installed builds, so in dev the SSO callback
//! comes back to `http://127.0.0.1:<ephemeral port>/auth/sso?...` instead. The listener
//! accepts exactly ONE request, only from loopback, only `GET /auth/sso` carrying the state
//! nonce it was started with, then closes. Release builds contain none of this: CI greps the
//! release binary for `MARKER` (and the debug binary, to prove the grep works).

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

/// Present in every response body, so it is linked into debug binaries (see the CI grep).
pub const MARKER: &str = "CHALITO_DEV_SSO_LOOPBACK";
pub const EVENT: &str = "chalito://sso-callback";
const WAIT: Duration = Duration::from_secs(10 * 60);
const READ_TIMEOUT: Duration = Duration::from_secs(5);

fn is_state(s: &str) -> bool {
    (22..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The request line → the callback as a `chalito://auth/sso?...` URL, so the webview runs the
/// same validation as for a real deep link. Pure, for the unit tests.
pub fn callback_from_request_line(line: &str, state: &str) -> Result<String, &'static str> {
    let mut parts = line.trim_end_matches(['\r', '\n']).split(' ');
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("malformed");
    };
    if method != "GET" {
        return Err("method");
    }
    if !version.starts_with("HTTP/1.") {
        return Err("version");
    }
    let Some(query) = target.strip_prefix("/auth/sso?") else {
        return Err("path");
    };
    let states: Vec<&str> = query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .filter(|(k, _)| *k == "state")
        .map(|(_, v)| v)
        .collect();
    if states.len() != 1 || states[0] != state {
        return Err("state");
    }
    Ok(format!("chalito://auth/sso?{query}"))
}

/// The request line, after draining the headers (closing a socket with unread data resets
/// the connection on Linux, and the browser would show an error instead of the page).
fn read_request(stream: &TcpStream) -> std::io::Result<String> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut first = String::new();
    reader.read_line(&mut first)?;
    let mut header = String::new();
    for _ in 0..100 {
        header.clear();
        if reader.read_line(&mut header)? == 0 || header == "\r\n" || header == "\n" {
            break;
        }
    }
    Ok(first)
}

fn respond(mut stream: TcpStream, ok: bool) {
    let (status, text) = if ok {
        ("200 OK", "Listo. Vuelve a Chalito. / Done. Go back to Chalito.")
    } else {
        ("400 Bad Request", "Solicitud no válida. / Invalid request.")
    };
    let body = format!("<!doctype html><meta charset=utf-8><title>Chalito</title><p>{text}</p><!-- {MARKER} -->");
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
}

/// Starts the one-shot listener; returns its port. The webview builds the redirect URI.
#[tauri::command]
pub fn sso_loopback(app: AppHandle, state: String) -> Result<u16, String> {
    if !is_state(&state) {
        return Err("bad state".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((stream, peer)) => {
                    // Exactly one request, whatever it is: the listener is dropped after this.
                    if !peer.ip().is_loopback() {
                        return respond(stream, false);
                    }
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
                    let result = match read_request(&stream) {
                        Ok(line) => callback_from_request_line(&line, &state),
                        Err(_) => Err("read"),
                    };
                    respond(stream, result.is_ok());
                    if let Ok(url) = result {
                        let _ = app.emit_to("panel", EVENT, url);
                    }
                    return;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(_) => return,
            }
        }
    });
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: &str = "AbCdEfGhIjKlMnOpQrStUv";

    #[test]
    fn accepts_only_get_auth_sso_with_the_state() {
        assert_eq!(
            callback_from_request_line(&format!("GET /auth/sso?token=t.sig&state={S}&next=%2F HTTP/1.1\r\n"), S),
            Ok(format!("chalito://auth/sso?token=t.sig&state={S}&next=%2F"))
        );
    }

    #[test]
    fn rejects_everything_else() {
        let cases = [
            (format!("POST /auth/sso?state={S} HTTP/1.1"), "method"),
            (format!("GET /other?state={S} HTTP/1.1"), "path"),
            ("GET /auth/sso HTTP/1.1".to_string(), "path"),
            ("GET /auth/sso?token=x HTTP/1.1".to_string(), "state"),
            ("GET /auth/sso?state=wrong HTTP/1.1".to_string(), "state"),
            (format!("GET /auth/sso?state={S}&state={S} HTTP/1.1"), "state"),
            (format!("GET /auth/sso?state={S}"), "malformed"),
            (format!("GET /auth/sso?state={S} SPDY/3"), "version"),
            (format!("GET /auth/sso?state={S} HTTP/1.1 extra"), "malformed"),
            (String::new(), "malformed"),
        ];
        for (line, why) in cases {
            assert_eq!(callback_from_request_line(&line, S), Err(why), "{line}");
        }
    }

    #[test]
    fn state_shape() {
        assert!(is_state(S));
        assert!(!is_state("short"));
        assert!(!is_state("has space in it, too long enough"));
        assert!(!is_state(&"a".repeat(129)));
    }

    #[test]
    fn serves_exactly_one_request_then_closes() {
        // The same accept-once shape as sso_loopback, without a Tauri app.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let t = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let line = read_request(&stream).unwrap();
            let r = callback_from_request_line(&line, S);
            respond(stream, r.is_ok());
            r
        });
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            c,
            "GET /auth/sso?token=x&state={S} HTTP/1.1\r\nHost: 127.0.0.1\r\nUser-Agent: test\r\nAccept: */*\r\n\r\n"
        )
        .unwrap();
        let mut resp = String::new();
        std::io::Read::read_to_string(&mut c, &mut resp).unwrap();
        assert!(resp.starts_with("HTTP/1.1 200 OK"));
        assert!(resp.contains(MARKER));
        assert!(t.join().unwrap().is_ok());
        // The listener is gone: a second request can't connect.
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }
}
