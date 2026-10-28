//! Idle time from the system itself: the cursor poll misses typing, and under XWayland it only sees
//! the pointer over our own windows, so it called a busy person idle (2026-10-26).

/// Milliseconds since the last input on this computer, or None when the desktop doesn't say.
/// GNOME's Mutter or KDE over D-Bus.
#[cfg(target_os = "linux")]
pub fn idle_ms() -> Option<u64> {
    use std::sync::OnceLock;
    use std::time::Duration;
    static BUS: OnceLock<Option<zbus::blocking::Connection>> = OnceLock::new();
    // A hung desktop answers late or never: give up fast
    // rather than hold a blocking thread for zbus's 25 s default.
    let bus = BUS
        .get_or_init(|| {
            zbus::blocking::connection::Builder::session()
                .ok()?
                .method_timeout(Duration::from_millis(500))
                .build()
                .ok()
        })
        .as_ref()?;
    let ask = |dest: &str, path: &str, iface: &str, method: &str| {
        bus.call_method(Some(dest), path, Some(iface), method, &()).ok()
    };
    if let Some(r) = ask(
        "org.gnome.Mutter.IdleMonitor",
        "/org/gnome/Mutter/IdleMonitor/Core",
        "org.gnome.Mutter.IdleMonitor",
        "GetIdletime",
    ) {
        if let Ok(ms) = r.body().deserialize::<u64>() {
            return Some(ms);
        }
    }
    // KDE: milliseconds as u32.
    let r = ask(
        "org.freedesktop.ScreenSaver",
        "/org/freedesktop/ScreenSaver",
        "org.freedesktop.ScreenSaver",
        "GetSessionIdleTime",
    )?;
    r.body().deserialize::<u32>().ok().map(u64::from)
}

/// Windows: the last keyboard or mouse input in this session.
#[cfg(windows)]
pub fn idle_ms() -> Option<u64> {
    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }
    let mut info = LastInputInfo {
        cb_size: std::mem::size_of::<LastInputInfo>() as u32,
        dw_time: 0,
    };
    // SAFETY: `info` is a valid LASTINPUTINFO with cbSize set, as the call requires.
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // Both are tick counts that wrap every ~49.7 days; the wrapping difference stays right.
    Some(u64::from(unsafe { GetTickCount() }.wrapping_sub(info.dw_time)))
}

/// macOS: seconds since any input event in the combined session state.
#[cfg(target_os = "macos")]
pub fn idle_ms() -> Option<u64> {
    const COMBINED_SESSION_STATE: i32 = 0;
    const ANY_INPUT_EVENT: u32 = !0;
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }
    // SAFETY: a pure query with constant arguments.
    let s =
        unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) };
    (s.is_finite() && s >= 0.0).then(|| (s * 1000.0) as u64)
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
pub fn idle_ms() -> Option<u64> {
    None
}

/// The poll's idle time, or the system's when it reports less (it sees input the poll can't).
pub fn combine(poll_ms: u64, os_ms: Option<u64>) -> u64 {
    os_ms.map_or(poll_ms, |o| o.min(poll_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_wins_when_it_saw_newer_input() {
        assert_eq!(combine(u64::MAX, Some(1_200)), 1_200);
        assert_eq!(combine(500, Some(9_000)), 500);
        assert_eq!(combine(42_000, None), 42_000);
    }

    /// The runner's session has had input since boot, or at least reports a number.
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn windows_and_macos_report_idle_time() {
        assert!(idle_ms().is_some());
    }
}
