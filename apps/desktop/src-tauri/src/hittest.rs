//! Click-through for the transparent pet window (D-006). Tauri has no per-pixel hit test,
//! so a thread polls the global cursor (~30 Hz) against the avatar's screen-space hit box
//! (sent by the webview) and toggles `set_ignore_cursor_events`. Everything here is pure so
//! it can be unit-tested without a window.

use serde::Deserialize;

/// A rectangle in PHYSICAL screen pixels (what `cursor_position` reports).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Inclusive top-left, exclusive bottom-right; mirrors `contains` in src/lib/hitbox.ts.
pub fn contains(r: &Rect, px: f64, py: f64) -> bool {
    px >= r.x && py >= r.y && px < r.x + r.width && py < r.y + r.height
}

/// Remembers what the window was last told, so the OS is only called on a change.
#[derive(Debug, Default)]
pub struct ClickThrough {
    ignoring: Option<bool>,
}

impl ClickThrough {
    /// The new `ignore` value to apply, or `None` when nothing changes. No hit box (avatar
    /// hidden, not rendered yet) or an unreadable cursor means "let clicks through".
    pub fn step(&mut self, hit: Option<&Rect>, cursor: Option<(f64, f64)>) -> Option<bool> {
        let over = match (hit, cursor) {
            (Some(r), Some((x, y))) => contains(r, x, y),
            _ => false,
        };
        let ignore = !over;
        if self.ignoring == Some(ignore) {
            None
        } else {
            self.ignoring = Some(ignore);
            Some(ignore)
        }
    }

    /// The window was changed elsewhere (e.g. focused at L4): record it, don't re-send.
    pub fn assume(&mut self, ignoring: bool) {
        self.ignoring = Some(ignoring);
    }
}

/// The pet takes focus only at escalation level L4 (the "knock"); everything below is
/// glance/wave/hop without stealing focus.
pub fn may_focus(level: &str) -> bool {
    level == "L4"
}

/// Input activity from the same cursor polling: the presence reporter's "active" signal
/// without an OS idle API. Keyboard-only use counts via the webviews' own input events.
#[derive(Debug, Default)]
pub struct Activity {
    last_pos: Option<(f64, f64)>,
    last_move_ms: Option<u64>,
}

impl Activity {
    pub fn observe(&mut self, pos: Option<(f64, f64)>, now_ms: u64) {
        if let Some(p) = pos {
            let moved = match self.last_pos {
                Some(q) => (p.0 - q.0).abs() >= 1.0 || (p.1 - q.1).abs() >= 1.0,
                None => true,
            };
            if moved {
                self.last_move_ms = Some(now_ms);
            }
            self.last_pos = Some(p);
        }
    }

    pub fn touch(&mut self, now_ms: u64) {
        self.last_move_ms = Some(now_ms);
    }

    /// Milliseconds since the last movement; `u64::MAX` when never seen.
    pub fn idle_ms(&self, now_ms: u64) -> u64 {
        self.last_move_ms.map_or(u64::MAX, |t| now_ms.saturating_sub(t))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOX: Rect = Rect { x: 100.0, y: 200.0, width: 50.0, height: 80.0 };

    #[test]
    fn contains_is_half_open() {
        assert!(contains(&BOX, 100.0, 200.0));
        assert!(contains(&BOX, 149.9, 279.9));
        assert!(!contains(&BOX, 150.0, 250.0));
        assert!(!contains(&BOX, 120.0, 280.0));
        assert!(!contains(&BOX, 99.9, 250.0));
    }

    #[test]
    fn toggles_only_on_change() {
        let mut ct = ClickThrough::default();
        // Starts click-through when the cursor is outside.
        assert_eq!(ct.step(Some(&BOX), Some((0.0, 0.0))), Some(true));
        assert_eq!(ct.step(Some(&BOX), Some((10.0, 10.0))), None);
        // Over the avatar: catch clicks.
        assert_eq!(ct.step(Some(&BOX), Some((120.0, 220.0))), Some(false));
        assert_eq!(ct.step(Some(&BOX), Some((121.0, 221.0))), None);
        // Leaves: click-through again.
        assert_eq!(ct.step(Some(&BOX), Some((500.0, 500.0))), Some(true));
    }

    #[test]
    fn no_box_or_no_cursor_means_click_through() {
        let mut ct = ClickThrough::default();
        assert_eq!(ct.step(None, Some((120.0, 220.0))), Some(true));
        ct.assume(false);
        assert_eq!(ct.step(Some(&BOX), None), Some(true));
    }

    #[test]
    fn negative_screen_coordinates_work() {
        // Monitors left of / above the primary one report negative positions.
        let left = Rect { x: -800.0, y: -100.0, width: 60.0, height: 60.0 };
        let mut ct = ClickThrough::default();
        assert_eq!(ct.step(Some(&left), Some((-780.0, -80.0))), Some(false));
    }

    #[test]
    fn focus_only_at_l4() {
        for l in ["L0", "L1", "L2", "L3", "", "l4", "L5"] {
            assert!(!may_focus(l), "{l}");
        }
        assert!(may_focus("L4"));
    }

    #[test]
    fn activity_tracks_movement() {
        let mut a = Activity::default();
        assert_eq!(a.idle_ms(1_000), u64::MAX);
        a.observe(Some((10.0, 10.0)), 1_000);
        a.observe(Some((10.4, 10.0)), 5_000); // sub-pixel jitter is not activity
        assert_eq!(a.idle_ms(6_000), 5_000);
        a.observe(Some((40.0, 10.0)), 7_000);
        assert_eq!(a.idle_ms(7_500), 500);
        a.observe(None, 9_000);
        assert_eq!(a.idle_ms(9_000), 2_000);
        a.touch(9_500);
        assert_eq!(a.idle_ms(9_600), 100);
    }
}
