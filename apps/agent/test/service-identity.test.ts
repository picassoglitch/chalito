import { describe, expect, it } from "vitest";
import { loadOrCreateIdentity } from "../src/identity.js";
import { MemorySecretStore } from "../src/secrets.js";
import { servicePlan } from "../src/service.js";

describe("identity", () => {
  it("creates keys once in the keychain and reloads the same device id", async () => {
    const secrets = new MemorySecretStore();
    const a = await loadOrCreateIdentity(secrets);
    const b = await loadOrCreateIdentity(secrets);
    expect(a.deviceId).toBe(b.deviceId);
    expect(a.deviceId).toMatch(/^dev_/);
    expect(secrets.values.size).toBe(1);
  });
});

describe("service plans", () => {
  it("macOS: a per-user LaunchAgent", () => {
    const p = servicePlan("darwin", "/Applications/Chalito.app/Contents/MacOS/chalito-agent", {
      home: "/Users/a",
      uid: 501,
    });
    expect(p.files[0]!.path).toBe("/Users/a/Library/LaunchAgents/com.chalito.agent.plist");
    // Restarted after a crash, not after a clean stop (a revoked device stops with 0).
    expect(p.files[0]!.content).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
    expect(p.install[0]).toEqual(["launchctl", "bootstrap", "gui/501", p.files[0]!.path]);
  });
  it("Linux: a systemd --user unit", () => {
    const p = servicePlan("linux", "/home/a/.local/bin/chalito-agent", { home: "/home/a" });
    expect(p.files[0]!.path).toBe("/home/a/.config/systemd/user/chalito-agent.service");
    expect(p.files[0]!.content).toContain('ExecStart="/home/a/.local/bin/chalito-agent" run');
    // 75 (another agent runs) and 78 (needs setup / revoked) never restart in a loop.
    expect(p.files[0]!.content).toContain("RestartPreventExitStatus=75 78");
    expect(p.install.at(-1)).toEqual(["systemctl", "--user", "enable", "--now", "chalito-agent.service"]);
  });
  it("Windows: a per-user logon Scheduled Task, never a Windows Service", () => {
    const p = servicePlan("win32", "C:\\Users\\a\\AppData\\Local\\Chalito\\chalito-agent.exe", {
      home: "C:\\Users\\a",
      user: "PC\\a",
    });
    expect(p.files[0]!.content).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(p.files[0]!.content).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(JSON.stringify(p.install)).not.toMatch(/sc\.exe|New-Service/);
  });
});
