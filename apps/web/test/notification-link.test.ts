import { describe, expect, it } from "vitest";
import { ackVia, notificationTarget } from "@/lib/notification-link";

describe("notification links (/n/<nid>)", () => {
  it("follows only our own deep links, localized", () => {
    expect(notificationTarget("/a/apr_1", "es")).toBe("/a/apr_1");
    expect(notificationTarget("/a/apr_1", "en")).toBe("/en/a/apr_1");
    expect(notificationTarget("/m/m1", "es")).toBe("/m/m1");
    expect(notificationTarget("/r/r1", "en")).toBe("/en/r/r1");
    expect(notificationTarget("/creditos", "es")).toBe("/creditos");
    for (const bad of ["https://evil.com/a/x", "//evil.com", "/ajustes", "/a/../dispositivos", "/a/x?y=1", ""])
      expect(notificationTarget(bad, "es"), bad).toBeNull();
  });
  it("acks via whatsapp from WhatsApp's link wrapper, or as the notifier says", () => {
    expect(ackVia("https://l.wl.co/l?u=x", null)).toBe("whatsapp");
    expect(ackVia("https://www.whatsapp.com/", null)).toBe("whatsapp");
    expect(ackVia("", "sms")).toBe("sms");
    expect(ackVia("", null)).toBe("app");
    expect(ackVia("https://evil.example/whatsapp", null)).toBe("app");
    expect(ackVia("", "email")).toBe("app");
  });
});
