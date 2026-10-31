import { describe, expect, it, vi } from "vitest";
import type * as KeyringNs from "@napi-rs/keyring";
import { CALENDAR_SECRET, CalendarService, localHost, normalizeCalendarUrl } from "../src/meetings/calendar.js";
import { GRANOLA_SECRET, GranolaTokenStore, GranolaTokensCorruptError } from "../src/meetings/granola-tokens.js";
import { codeService } from "../src/code/service.js";
import { NEVER_FILE, type FollowUpSource } from "../src/meetings/followups.js";
import { inCall, listProcesses } from "../src/meetings/in-call.js";
import { FOLLOWUPS_ON_SECRET, meetingHandlers, meetingsFeature } from "../src/meetings/ipc.js";
import { FakeFollowUpSource } from "../src/meetings/followups.js";
import { KeyringStore, MemorySecretStore } from "../src/secrets.js";
import { ipcHandlers, type IpcDeps } from "../src/ipc-handlers.js";
import type { CommandResult } from "../src/agent-core.js";

const ms = (iso: string) => Date.parse(iso);
const URL_OK = "https://calendar.example.com/private-abc123/basic.ics";
const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:x1",
  "SUMMARY:Revisión con cliente",
  "DTSTART:20261026T160000Z",
  "DTEND:20261026T163000Z",
  "LOCATION:https://zoom.us/j/999",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const fakeFetch = (body: string, status = 200) =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe("calendar link", () => {
  it("accepts https and webcal, refuses anything else", () => {
    expect(normalizeCalendarUrl(" webcal://calendar.example.com/a.ics ")).toBe("https://calendar.example.com/a.ics");
    expect(normalizeCalendarUrl("http://calendar.example.com/a.ics")).toBeNull();
    expect(normalizeCalendarUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeCalendarUrl("no es un link")).toBeNull();
  });

  it("saves the link in the keychain only after a good test read", async () => {
    const secrets = new MemorySecretStore();
    const bad = new CalendarService({ secrets, fetch: fakeFetch("<html>login</html>") });
    expect(await bad.setUrl(URL_OK)).toEqual({ ok: false, reason: "not_calendar" });
    expect(secrets.values.size).toBe(0);
    const good = new CalendarService({ secrets, fetch: fakeFetch(ICS), now: () => ms("2026-10-26T15:50:00Z") });
    expect(await good.setUrl(URL_OK)).toEqual({ ok: true });
    expect(secrets.values.get(CALENDAR_SECRET)).toBe(URL_OK);
    expect((await good.upcoming()).meetings.map((m) => m.title)).toEqual(["Revisión con cliente"]);
    await good.clear();
    expect(secrets.values.size).toBe(0);
    expect(await good.upcoming()).toEqual({ configured: false, meetings: [], error: null, unsupported: 0 });
  });

  it("caches for 5 minutes, refreshes in the background, keeps the last good copy, backs off after a failure", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(CALENDAR_SECRET, URL_OK);
    let now = ms("2026-10-26T15:00:00Z");
    let fail = false;
    const f = vi.fn(async () => (fail ? new Response("", { status: 503 }) : new Response(ICS)));
    const warn = vi.fn();
    const cal = new CalendarService({ secrets, fetch: f as unknown as typeof fetch, now: () => now, warn });
    await cal.upcoming();
    await cal.upcoming();
    expect(f).toHaveBeenCalledTimes(1);
    now += 5 * 60_000;
    fail = true;
    expect((await cal.upcoming()).meetings).toHaveLength(1);
    await cal.settled();
    const up = await cal.upcoming();
    expect(f).toHaveBeenCalledTimes(2);
    expect(up.error).toBe("fetch_failed");
    expect(up.meetings).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("calendar.read_failed", { cause: "http", status: 503 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-abc123");
    now += 30_000;
    await cal.upcoming();
    expect(f).toHaveBeenCalledTimes(2);
    now += 31_000;
    fail = false;
    await cal.upcoming();
    await cal.settled();
    expect((await cal.upcoming()).error).toBeNull();
  });

  it("a hung host never blocks a poll once there's a copy", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(CALENDAR_SECRET, URL_OK);
    let now = ms("2026-10-26T15:00:00Z");
    let hang = false;
    const f = vi.fn(async () => (hang ? new Promise<Response>(() => undefined) : new Response(ICS)));
    const cal = new CalendarService({ secrets, fetch: f as unknown as typeof fetch, now: () => now });
    await cal.upcoming();
    hang = true;
    now += 6 * 60_000;
    const t0 = Date.now();
    const up = await cal.upcoming();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(up.meetings).toHaveLength(1);
    expect(up.error).toBeNull();
  });

  it("tells a rejected link, a network error and an oversize feed apart, and saves none of them", async () => {
    const secrets = new MemorySecretStore();
    const reject = new CalendarService({ secrets, fetch: fakeFetch("nope", 404) });
    expect(await reject.setUrl(URL_OK)).toEqual({ ok: false, reason: "link_rejected" });
    const down = new CalendarService({
      secrets,
      fetch: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
    });
    expect(await down.setUrl(URL_OK)).toEqual({ ok: false, reason: "fetch_failed" });
    const big = `BEGIN:VCALENDAR\r\n${"é".repeat(3 * 1024 * 1024)}`;
    expect(await new CalendarService({ secrets, fetch: fakeFetch(big) }).setUrl(URL_OK)).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(secrets.values.size).toBe(0);
    const saved = new MemorySecretStore();
    await saved.set(CALENDAR_SECRET, URL_OK);
    const first = new CalendarService({ secrets: saved, fetch: fakeFetch("", 500) });
    expect(await first.upcoming()).toMatchObject({ configured: true, meetings: [], error: "fetch_failed" });
  });

  it("a read of the old link that lands after a new link is saved is dropped", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(CALENDAR_SECRET, URL_OK);
    const NEW = "https://calendar.example.com/new.ics";
    let now = ms("2026-10-26T15:00:00Z");
    let release: (r: Response) => void = () => undefined;
    let slowOld = false;
    const f = vi.fn(async (u: string) =>
      u === NEW
        ? new Response(ICS.replace("Revisión con cliente", "NEW"))
        : slowOld
          ? new Promise<Response>((res) => (release = res))
          : new Response(ICS.replace("Revisión con cliente", "OLD")),
    );
    const cal = new CalendarService({ secrets, fetch: f as unknown as typeof fetch, now: () => now });
    await cal.upcoming();
    slowOld = true;
    now += 6 * 60_000;
    await cal.upcoming();
    expect(await cal.setUrl(NEW)).toEqual({ ok: true });
    release(new Response(ICS.replace("Revisión con cliente", "OLD")));
    await cal.settled();
    expect((await cal.upcoming()).meetings.map((m) => m.title)).toEqual(["NEW"]);
  });

  it("a chunked feed with no length is cut off once it passes 5 MB", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 50) return c.close();
        c.enqueue(new Uint8Array(1024 * 1024).fill(65));
      },
    });
    const cal = new CalendarService({
      secrets: new MemorySecretStore(),
      fetch: vi.fn(async () => new Response(stream)) as unknown as typeof fetch,
    });
    expect(await cal.setUrl(URL_OK)).toEqual({ ok: false, reason: "too_large" });
    expect(pulled).toBeLessThan(10);
  });

  it.each([
    "https://127.0.0.1/feed.ics",
    "https://localhost/feed.ics",
    "https://10.1.2.3/feed.ics",
    "https://192.168.0.10/feed.ics",
    "https://172.16.5.4/feed.ics",
    "https://169.254.169.254/latest",
    "https://[::1]/feed.ics",
    "https://[fe80::1]/feed.ics",
    "https://[fd00::2]/feed.ics",
    "https://[::127.0.0.1]/feed.ics",
    "https://[64:ff9b::7f00:1]/feed.ics",
    "https://[64:ff9b::10.0.0.1]/feed.ics",
    "https://[::ffff:127.0.0.1]/feed.ics",
    "https://0.0.0.0/feed.ics",
  ])("refuses a redirect into this machine or the local network: %s", async (to) => {
    const f = vi.fn(async (u: string) =>
      u === URL_OK ? new Response(null, { status: 302, headers: { location: to } }) : new Response(ICS),
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    expect(await new CalendarService({ secrets: new MemorySecretStore(), fetch: f }).setUrl(URL_OK)).toEqual({
      ok: false,
      reason: "fetch_failed",
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://127.0.0.1/x.ics",
    "webcal://192.168.1.20/cal.ics",
    "https://[::1]/x.ics",
    "https://localhost/x.ics",
  ])("refuses a pasted link to this machine or the local network, without fetching it: %s", async (link) => {
    const secrets = new MemorySecretStore();
    const f = fakeFetch(ICS);
    expect(await new CalendarService({ secrets, fetch: f }).setUrl(link)).toEqual({
      ok: false,
      reason: "local_address",
    });
    expect(f).not.toHaveBeenCalled();
    expect(secrets.values.size).toBe(0);
  });

  it("a stored link that points at the local network is never polled", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(CALENDAR_SECRET, "https://10.0.0.7/feed.ics");
    const f = fakeFetch(ICS);
    const cal = new CalendarService({ secrets, fetch: f });
    expect(await cal.upcoming()).toMatchObject({ configured: true, meetings: [], error: "local_address" });
    expect(f).not.toHaveBeenCalled();
  });

  it("tells local hosts from public ones, including the URL parser's rewritten forms", () => {
    const host = (u: string) => localHost(new URL(u).hostname);
    expect(host("https://2130706433/x")).toBe(true); // decimal 127.0.0.1
    expect(host("https://0x7f.1/x")).toBe(true);
    expect(host("https://cdn.example.com/x")).toBe(false);
    expect(host("https://8.8.8.8/x")).toBe(false);
    expect(host("https://172.32.0.1/x")).toBe(false);
    expect(host("https://[2001:db8::1]/x")).toBe(false);
  });

  it("counts series it had to cut short as unreadable", async () => {
    const feed = ICS.replace(
      "END:VCALENDAR",
      "BEGIN:VEVENT\r\nUID:l\r\nSUMMARY:x\r\nDTSTART:19500102T150000Z\r\nRRULE:FREQ=DAILY;COUNT=10000;BYDAY=MO\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    const cal = new CalendarService({ secrets: new MemorySecretStore(), fetch: fakeFetch(feed) });
    await cal.setUrl(URL_OK);
    expect((await cal.upcoming()).unsupported).toBe(1);
  });

  it("follows https redirects but never one to http", async () => {
    const hops = (to: string) =>
      vi.fn(async (u: string) =>
        u === URL_OK ? new Response(null, { status: 302, headers: { location: to } }) : new Response(ICS),
      ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const safe = hops("https://cdn.example.com/feed.ics");
    expect(await new CalendarService({ secrets: new MemorySecretStore(), fetch: safe }).setUrl(URL_OK)).toEqual({
      ok: true,
    });
    expect(safe.mock.calls.map((c) => c[0])).toEqual([URL_OK, "https://cdn.example.com/feed.ics"]);
    const leak = hops("http://cdn.example.com/feed.ics");
    expect(await new CalendarService({ secrets: new MemorySecretStore(), fetch: leak }).setUrl(URL_OK)).toEqual({
      ok: false,
      reason: "fetch_failed",
    });
    expect(leak).toHaveBeenCalledTimes(1);
  });

  it("a keychain that won't write says so instead of looking like a bad link", async () => {
    const secrets = new MemorySecretStore();
    secrets.set = async () => Promise.reject(new Error("no Secret Service"));
    expect(await new CalendarService({ secrets, fetch: fakeFetch(ICS) }).setUrl(URL_OK)).toEqual({
      ok: false,
      reason: "keychain",
    });
  });

  it("counts repeating meetings it can't expand", async () => {
    const secrets = new MemorySecretStore();
    const feed = ICS.replace(
      "END:VCALENDAR",
      "BEGIN:VEVENT\r\nUID:u\r\nSUMMARY:x\r\nDTSTART:20260105T150000Z\r\nRRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1\r\nEND:VEVENT\r\nEND:VCALENDAR",
    );
    const cal = new CalendarService({ secrets, fetch: fakeFetch(feed) });
    await cal.setUrl(URL_OK);
    expect((await cal.upcoming()).unsupported).toBe(1);
  });
});

describe("keychain storage", () => {
  const fakeKeyring = () => {
    const store = new Map<string, string>();
    const calls: { service: string; name: string; opts: unknown }[] = [];
    class Entry {
      constructor(
        private readonly service: string,
        private readonly name: string,
        opts: unknown,
      ) {
        calls.push({ service, name, opts });
      }
      getPassword() {
        return store.get(`${this.service}/${this.name}`) ?? null;
      }
      setPassword(v: string) {
        store.set(`${this.service}/${this.name}`, v);
      }
      deletePassword() {
        store.delete(`${this.service}/${this.name}`);
      }
    }
    return { store, calls, load: async () => ({ Entry }) as unknown as typeof KeyringNs };
  };

  it("Granola's OAuth state goes into the OS keychain entry the agent uses, as one item", async () => {
    const k = fakeKeyring();
    const tokens = new GranolaTokenStore(new KeyringStore(k.load));
    expect(await tokens.connected()).toBe(false);
    await tokens.save({ client: { client_id: "c" }, verifier: "v" });
    await tokens.save({ tokens: { access_token: "a", refresh_token: "r" }, verifier: undefined });
    expect(k.calls.every((c) => c.service === "com.chalito.agent" && c.name === GRANOLA_SECRET)).toBe(true);
    expect(k.calls[0]?.opts).toEqual({ linux: { store: "secret-service" } });
    expect(JSON.parse(k.store.get(`com.chalito.agent/${GRANOLA_SECRET}`)!)).toEqual({
      client: { client_id: "c" },
      tokens: { access_token: "a", refresh_token: "r" },
    });
    expect(await tokens.connected()).toBe(true);
    await tokens.clear();
    expect(k.store.size).toBe(0);
  });

  it("the calendar link goes into the same keychain service", async () => {
    const k = fakeKeyring();
    const cal = new CalendarService({ secrets: new KeyringStore(k.load), fetch: fakeFetch(ICS) });
    await cal.setUrl(URL_OK);
    expect(k.store.get(`com.chalito.agent/${CALENDAR_SECRET}`)).toBe(URL_OK);
  });

  it("an unreadable Granola entry says reconnect, it doesn't pass for never connected", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set(GRANOLA_SECRET, "{not json");
    await expect(new GranolaTokenStore(secrets).connected()).rejects.toThrow(GranolaTokensCorruptError);
    await secrets.set(GRANOLA_SECRET, "[1]");
    await expect(new GranolaTokenStore(secrets).read()).rejects.toThrow(GranolaTokensCorruptError);
    await new GranolaTokenStore(secrets).save({ tokens: { access_token: "fresh" } });
    expect(JSON.parse(secrets.values.get(GRANOLA_SECRET)!)).toEqual({ tokens: { access_token: "fresh" } });
  });

  it("a broken keychain fails closed: nothing saved anywhere else", async () => {
    const tokens = new GranolaTokenStore(new KeyringStore(async () => Promise.reject(new Error("no addon"))));
    await expect(tokens.save({ tokens: { a: 1 } })).rejects.toThrow(/keychain/);
  });

  it("neither store touches the file system", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["granola-tokens.ts", "calendar.ts", "followups.ts"]) {
      const src = readFileSync(new URL(`../src/meetings/${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/node:fs|writeFile|mkdir/);
    }
  });
});

describe("in a call", () => {
  const run = (out: string, err: Error | null = null) =>
    ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(err, out)) as never;

  it("Zoom's in-meeting helper on macOS and Windows reads as a call", async () => {
    const mac = "/sbin/launchd\n/Applications/zoom.us.app/Contents/Frameworks/cpthost.app/Contents/MacOS/CptHost\n";
    expect(await inCall(listProcesses("darwin", run(mac)))).toBe(true);
    const win = '"System","4","Services","0","100 K"\r\n"CptHost.exe","9120","Console","1","40,000 K"\r\n';
    expect(await inCall(listProcesses("win32", run(win)))).toBe(true);
  });

  it("Zoom open without a meeting, Teams and browsers read as no call", async () => {
    const mac =
      "/Applications/zoom.us.app/Contents/MacOS/zoom.us\n/Applications/Microsoft Teams.app/x/MSTeams\nGoogle Chrome\n";
    expect(await inCall(listProcesses("darwin", run(mac)))).toBe(false);
  });

  it("a failing process list degrades quietly to no call", async () => {
    expect(await inCall(listProcesses("linux", run("", new Error("ENOENT"))))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("the real process list reads this machine (and finds node)", async () => {
    const names = await listProcesses()();
    expect(names.length).toBeGreaterThan(1);
    expect(names.some((n) => /node/i.test(n))).toBe(true);
    expect(await inCall(listProcesses())).toBe(false);
  });
});

describe("panel IPC", () => {
  const setup = async (o: { processes?: string[]; now?: string } = {}) => {
    const secrets = new MemorySecretStore();
    const start = vi.fn(async (): Promise<CommandResult> => ({ ok: true, sid: "s-9" }));
    const feature = meetingsFeature({
      secrets,
      code: { start, apps: () => ({ apps: ["claude-code"], workspaces: ["chalito"] }) },
      locale: () => "es",
      fetch: fakeFetch(ICS),
      processes: async () => o.processes ?? [],
      now: () => ms(o.now ?? "2026-10-26T15:52:00Z"),
      source: new FakeFollowUpSource([{ id: "m1", title: "Planeación", startMs: ms("2026-10-26T14:00:00Z") }], {
        m1: "TICKET | Arreglar el login | falla | Ana | Beto",
      }),
    });
    const h = ipcHandlers({ meetings: feature } as unknown as IpcDeps);
    return { h, secrets, start };
  };

  it("is wired into the agent's handlers and answers unavailable without the feature", async () => {
    const h = ipcHandlers({} as unknown as IpcDeps);
    await expect(h.meetingsUpcoming!(null)).rejects.toThrow("unavailable");
    expect(Object.keys(meetingHandlers(undefined)).every((k) => k in h)).toBe(true);
  });

  it("calendarSet → meetingsUpcoming, with the in-call check only near a meeting", async () => {
    const near = await setup({ processes: ["/x/CptHost"] });
    expect(await near.h.calendarSet!({ url: URL_OK })).toEqual({ ok: true });
    const up = (await near.h.meetingsUpcoming!(null)) as { meetings: unknown[]; inCall: boolean };
    expect(up.meetings).toHaveLength(1);
    expect(up.inCall).toBe(true);
    const far = await setup({ processes: ["/x/CptHost"], now: "2026-10-26T15:00:00Z" });
    await far.h.calendarSet!({ url: URL_OK });
    expect(((await far.h.meetingsUpcoming!(null)) as { inCall: boolean }).inCall).toBe(false);
    await expect(near.h.calendarSet!({ url: "http://x" })).resolves.toEqual({ ok: false, reason: "bad_url" });
    await expect(near.h.calendarSet!({ url: 3 })).rejects.toThrow("bad_params");
  });

  it("follow-ups are opt-in: off lists nothing and refuses a decision", async () => {
    const { h, start } = await setup();
    expect(await h.followUpsList!(null)).toEqual({ available: true, enabled: false, cards: [], error: null });
    await expect(h.followUpsDecide!({ ref: "m1:x", choice: "yes" })).rejects.toThrow("followups_off");
    expect(start).not.toHaveBeenCalled();
  });

  it("on: the card's Sí starts a plan-mode session through the session starter", async () => {
    const { h, secrets, start } = await setup();
    await h.followUpsEnable!({ on: true });
    expect(secrets.values.get(FOLLOWUPS_ON_SECRET)).toBe("1");
    const list = (await h.followUpsList!(null)) as { cards: { ref: string }[] };
    expect(list.cards).toHaveLength(1);
    expect(await h.followUpsDecide!({ ref: list.cards[0]!.ref, choice: "yes" })).toEqual({ ok: true, sid: "s-9" });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "plan" }));
    await h.followUpsEnable!({ on: false });
    expect(secrets.values.has(FOLLOWUPS_ON_SECRET)).toBe(false);
  });

  it("refuses bad params and passes the engine's refusals through", async () => {
    const { h } = await setup();
    await h.followUpsEnable!({ on: true });
    for (const bad of [
      { ref: "m1:x", choice: "maybe" },
      { ref: "m1/x", choice: "yes" },
      { ref: "m1 x", choice: "yes" },
      { ref: "a".repeat(301), choice: "yes" },
      { ref: "m1:x", choice: "yes", extra: 1 },
    ])
      await expect(h.followUpsDecide!(bad)).rejects.toThrow("bad_params");
    await expect(h.followUpsEnable!({ on: "1" })).rejects.toThrow("bad_params");
    await expect(h.followUpsDecide!({ ref: "m1:nope", choice: "yes" })).rejects.toThrow("unknown_item");
  });

  it("a source outage keeps the cards it has and reports the error", async () => {
    let down = false;
    const source: FollowUpSource = {
      finishedMeetings: async () => {
        if (down) throw new Error("granola 503");
        return [{ id: "m1", title: "x", startMs: ms("2026-10-26T14:00:00Z") }];
      },
      followUps: async () => "TICKET | Arreglar el login | falla | Ana | Beto",
    };
    let now = ms("2026-10-26T15:00:00Z");
    const warn = vi.fn();
    const feature = meetingsFeature({
      secrets: new MemorySecretStore(),
      code: { start: vi.fn(), apps: () => ({ apps: [], workspaces: [] }) },
      locale: () => "es",
      source,
      now: () => now,
      warn,
    });
    const h = meetingHandlers(feature);
    await h.followUpsEnable!({ on: true });
    expect(((await h.followUpsList!(null)) as { cards: unknown[] }).cards).toHaveLength(1);
    down = true;
    now += 6 * 60_000;
    await h.followUpsList!(null);
    expect(warn).toHaveBeenCalledWith("followups.source_failed", { error: "granola 503" });
    now += 6 * 60_000;
    expect(await h.followUpsList!(null)).toMatchObject({
      error: "source_failed",
      cards: [{ ref: expect.any(String) }],
    });
  });

  it("Sí through the real session service reaches the agent as a plan-mode session.start that only drafts", async () => {
    const localCommand = vi.fn(async (): Promise<CommandResult> => ({ ok: true, sid: "s-real" }));
    const code = codeService(
      { localCommand, tap: () => () => undefined },
      () => ({ workspaces: [{ label: "chalito", path: "/tmp" }] as never }),
      () => ({ adapters: ["claude-code"] }) as never,
      "local",
    );
    const feature = meetingsFeature({
      secrets: new MemorySecretStore(),
      code,
      locale: () => "es",
      now: () => ms("2026-10-26T15:00:00Z"),
      source: new FakeFollowUpSource([{ id: "m1", title: "Planeación", startMs: ms("2026-10-26T14:00:00Z") }], {
        m1: "TICKET | Arreglar el login | falla | Ana | Beto",
      }),
    });
    const h = meetingHandlers(feature);
    await h.followUpsEnable!({ on: true });
    const [card] = ((await h.followUpsList!(null)) as { cards: { ref: string }[] }).cards;
    expect(await h.followUpsDecide!({ ref: card!.ref, choice: "yes" })).toEqual({ ok: true, sid: "s-real" });
    expect(localCommand).toHaveBeenCalledTimes(1);
    expect(localCommand).toHaveBeenCalledWith("local", {
      type: "session.start",
      appId: "claude-code",
      workspaceLabel: "chalito",
      permissionMode: "plan",
      prompt: expect.stringContaining(NEVER_FILE.es),
    });
  });
});
