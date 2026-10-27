//! Idle time from the desktop itself. Under XWayland the cursor poll only sees the pointer over our own
//! windows, so it called a busy person idle (2026-10-26). GNOME's Mutter and KDE answer over D-Bus.

/// Milliseconds since the last input on this computer, or None when the desktop doesn't say.
#[cfg(target_os = "linux")]
pub fn idle_ms() -> Option<u64> {
    use std::sync::OnceLock;
    static BUS: OnceLock<Option<zbus::blocking::Connection>> = OnceLock::new();
    let bus = BUS.get_or_init(|| zbus::blocking::Connection::session().ok()).as_ref()?;
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

#[cfg(not(target_os = "linux"))]
pub fn idle_ms() -> Option<u64> {
    None
}

/// The poll's idle time, or the desktop's when it reports less (it sees input the poll can't).
pub fn combine(poll_ms: u64, os_ms: Option<u64>) -> u64 {
    os_ms.map_or(poll_ms, |o| o.min(poll_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desktop_wins_when_it_saw_newer_input() {
        assert_eq!(combine(u64::MAX, Some(1_200)), 1_200);
        assert_eq!(combine(500, Some(9_000)), 500);
        assert_eq!(combine(42_000, None), 42_000);
    }
}
