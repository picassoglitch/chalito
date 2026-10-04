import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-user service definitions (ADR 0004). The OS service owns the daemon's lifecycle;
 * the desktop app talks to it over local IPC. Windows uses a per-user Scheduled Task,
 * not a Windows Service (a Service runs as SYSTEM and can't read the user's keychain; D-005).
 */
export const LABEL = "com.chalito.agent";

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const launchdPlist = (bin: string, logDir: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(bin)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(join(logDir, "agent.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(logDir, "agent.log"))}</string>
</dict>
</plist>
`;

export const systemdUnit = (bin: string) => `[Unit]
Description=Chalito agent
After=network-online.target

[Service]
Type=simple
ExecStart="${bin}" run
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;

export const windowsTaskXml = (bin: string, user: string) => `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Chalito agent</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlEscape(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEscape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEscape(bin)}</Command><Arguments>run</Arguments></Exec></Actions>
</Task>
`;

export interface ServicePlan {
  files: { path: string; content: string }[];
  install: string[][];
  uninstall: string[][];
}

/** What `chalito service install|uninstall` writes and runs on each OS. */
export const servicePlan = (
  platform: NodeJS.Platform,
  bin: string,
  opts: { home?: string; uid?: number; user?: string } = {},
): ServicePlan => {
  const home = opts.home ?? homedir();
  if (platform === "darwin") {
    const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const domain = `gui/${opts.uid ?? process.getuid?.() ?? 501}`;
    return {
      files: [{ path: plist, content: launchdPlist(bin, join(home, ".chalito", "logs")) }],
      install: [["launchctl", "bootstrap", domain, plist]],
      uninstall: [["launchctl", "bootout", `${domain}/${LABEL}`]],
    };
  }
  if (platform === "linux") {
    const unit = join(home, ".config", "systemd", "user", "chalito-agent.service");
    return {
      files: [{ path: unit, content: systemdUnit(bin) }],
      install: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "chalito-agent.service"],
      ],
      uninstall: [["systemctl", "--user", "disable", "--now", "chalito-agent.service"]],
    };
  }
  if (platform === "win32") {
    const xml = join(home, ".chalito", "chalito-agent-task.xml");
    return {
      files: [{ path: xml, content: windowsTaskXml(bin, opts.user ?? process.env.USERNAME ?? "") }],
      install: [
        ["schtasks", "/Create", "/TN", "Chalito Agent", "/XML", xml, "/F"],
        ["schtasks", "/Run", "/TN", "Chalito Agent"],
      ],
      uninstall: [["schtasks", "/Delete", "/TN", "Chalito Agent", "/F"]],
    };
  }
  throw new Error(`unsupported platform ${platform}`);
};
