/**
 * Whether the panel opens by itself at launch. It starts hidden (tauri.conf.json) so a set-up
 * computer only shows the pet; until this device is signed in and connected, though, the pet
 * alone is a dead end (and on Linux there may be no tray to open the panel from), so the panel
 * comes up on its sign-in and "Conectar esta computadora" steps.
 */
export const panelOnLaunch = (o: { configured: boolean; connected: boolean }): boolean => !o.configured || !o.connected;
