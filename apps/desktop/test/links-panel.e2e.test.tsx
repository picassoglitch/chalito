// D-070: the panel's link flow against the real agent IPC handlers and link manager, with
// `invokeIpc` going through `ipcHandlers` as the native side would carry it.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDeviceId, generateBoxKeyPair, generateSigningKeyPair, toB64url } from "@chalito/crypto";
import { keyFingerprint } from "@chalito/client-keys";
import type { Locale } from "@chalito/protocol";
import { ipcHandlers } from "../../agent/src/ipc-handlers.js";
import { LINK_COPY, LinkManager, MemoryLinkCloud, MemoryLinkStorage } from "../../agent/src/links/index.js";
import { DEFAULT_POLICY, type Policy } from "../../agent/src/policy/index.js";
import { createLogger } from "../../agent/src/redact.js";
import { TextProviders } from "../src/lib/i18n.js";
import { invokeIpc, unavailableIpc, type AgentIpc, type LinkSpec } from "../src/lib/ipc.js";
import { deviceCode, linkCode, parseLinkCode } from "../src/lib/link-codes.js";
import { Links } from "../src/panel/Links.js";

afterEach(cleanup);

const OWNER = "hub-user-1";
const short = (deviceId: string) => deviceId.slice(0, 8);

/** One computer: its keys, a real LinkManager, and the real IPC handlers behind the panel's client. */
// `_name` only labels the call; the id is derived from the key, as an agent's is (identity.ts).
const computer = async (_name: string, o: { workspaces?: string[]; osAuth?: boolean } = {}) => {
  const sign = await generateSigningKeyPair();
  const id = await deriveDeviceId(sign.publicKey);
  const box = await generateBoxKeyPair();
  const pubSign = await toB64url(sign.publicKey);
  const pubBox = await toB64url(box.publicKey);
  const policy: Policy = {
    ...DEFAULT_POLICY,
    workspaces: (o.workspaces ?? ["chalito"]).map((label) => ({ label, path: `/home/aldo/${label}` })),
  };
  const cloud = new MemoryLinkCloud();
  const links = new LinkManager({
    deviceId: id,
    owner: OWNER,
    sign,
    box,
    pubBox,
    storage: new MemoryLinkStorage(),
    cloud,
    policy: () => policy,
    audit: () => undefined,
    publishDeviceEvent: async () => undefined,
    now: Date.now,
    log: createLogger(() => undefined),
    setTimer: () => ({ clear: () => undefined }),
  });
  const osAsked: string[] = [];
  const auth = { ok: o.osAuth ?? true };
  const handlers = ipcHandlers({
    links,
    identity: { deviceId: id, pubSign, pubBox },
    osAuth: () => ({ verify: async (why: string) => (osAsked.push(why), auth.ok) }),
    locale: () => "es",
    policy: { get: () => policy },
  } as never) as Record<string, (params: unknown) => Promise<unknown>>;
  // As src-tauri's agent_ipc relays it: a refusal comes back as its code string.
  const invoke = async <T,>(_cmd: string, args: Record<string, unknown>): Promise<T> => {
    try {
      return (await handlers[args.method as string]!(args.params ?? undefined)) as T;
    } catch (e) {
      throw e instanceof Error ? e.message : String(e);
    }
  };
  return { id, pubSign, pubBox, links, cloud, osAsked, auth, ipc: invokeIpc(invoke) };
};

const renderLinks = (ipc: AgentIpc, locale: Locale = "es") =>
  render(
    <TextProviders locale={locale}>
      <Links ipc={ipc} />
    </TextProviders>,
  );

const section = () => screen.getByRole("heading", { name: "Enlaces entre agentes" }).closest("section")!;

const fillNew = async (o: {
  goal?: string;
  workspace?: string;
  otherCode?: string;
  direction?: "send" | "receive";
}) => {
  // After a refusal the form stays open with the draft, so the owner can try again.
  await waitFor(() =>
    expect(screen.queryByText("Nuevo enlace…") ?? screen.queryByText("Para qué es el enlace")).not.toBeNull(),
  );
  const open = screen.queryByRole("button", { name: "Nuevo enlace…" });
  if (open) fireEvent.click(open);
  if (o.otherCode !== undefined) {
    fireEvent.click(screen.getByLabelText("Un agente en otra de mis computadoras"));
    fireEvent.change(screen.getByLabelText(/Código de la otra computadora/), { target: { value: o.otherCode } });
    if (o.direction === "receive") fireEvent.click(screen.getByLabelText("La otra computadora le pasa trabajo a esta"));
  }
  const ws = screen.getByLabelText("Carpeta donde se trabaja");
  if (o.workspace !== undefined) {
    await waitFor(() =>
      expect(ws.tagName === "INPUT" || !o.workspace || within(ws).queryByText(o.workspace) !== null).toBe(true),
    );
    fireEvent.change(ws, { target: { value: o.workspace } });
  }
  if (o.goal !== undefined)
    fireEvent.change(screen.getByLabelText("Para qué es el enlace"), { target: { value: o.goal } });
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
};

/** The agent's challenge: its summary, then the typed phrase. */
const passChallenge = async (phrase = LINK_COPY.es.phrase) => {
  await screen.findByText(LINK_COPY.es.handoff[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
  const input = await screen.findByLabelText(LINK_COPY.es.phrase);
  const confirm = screen.getByRole("button", { name: "Crear el enlace" });
  fireEvent.change(input, { target: { value: "enlazar" } });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: phrase } });
  fireEvent.click(confirm);
};

describe("panel → agent: making hand-off links (D-070)", () => {
  it("a same-computer hand-off link: challenge, OS check, then it's listed as local", async () => {
    const a = await computer("dev_a1");
    renderLinks(a.ipc);
    await fillNew({ workspace: "chalito", goal: "Revisar mis PR" });
    await passChallenge();
    await screen.findByText("Enlace creado.");
    expect(a.osAsked).toEqual(["Chalito: enlazar agentes"]);
    const [link] = a.links.list();
    expect(link).toMatchObject({
      mode: "handoff",
      createdBy: "local",
      sender: { deviceId: a.id },
      receiver: { deviceId: a.id },
      workspaceLabel: "chalito",
      goal: "Revisar mis PR",
      confirm: true,
      permissionCeiling: "default",
    });
    // Same computer: no code to carry anywhere.
    expect(screen.queryByLabelText("Código del enlace")).toBeNull();
    const row = await waitFor(() => section().querySelector(`[data-link="${link!.id}"]`)!);
    expect(within(row as HTMLElement).getByText(/Encargo: Esta computadora → Esta computadora/)).toBeTruthy();
  });

  it("across computers: A makes it with B's code, B makes the same link from A's code", async () => {
    const a = await computer("dev_a1", { workspaces: ["chalito"] });
    const b = await computer("dev_b1", { workspaces: ["repo"] });
    const bCode = deviceCode({ deviceId: b.id, pubSign: b.pubSign, pubBox: b.pubBox });

    const viewA = renderLinks(a.ipc);
    await fillNew({ otherCode: bCode, workspace: "repo", goal: "Tareas del plan" });
    await passChallenge();
    const code = ((await screen.findByLabelText("Código del enlace")) as HTMLTextAreaElement).value;
    viewA.unmount();

    renderLinks(b.ipc);
    fireEvent.click(await screen.findByRole("button", { name: "Pegar un enlace de otra computadora…" }));
    fireEvent.change(screen.getByLabelText("Código del enlace"), { target: { value: code } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }));
    await screen.findByText(`Encargo: ${short(a.id)} → Esta computadora`);
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await passChallenge();
    await screen.findByText("Enlace creado.");

    const onA = a.links.list()[0]!;
    const onB = b.links.list()[0]!;
    const strip = ({ createdAt: _c, ...l }: typeof onA) => l;
    expect(strip(onB)).toEqual(strip(onA));
    expect(onA.sender).toEqual({ deviceId: a.id, pubSign: a.pubSign, pubBox: a.pubBox });
    expect(onA.receiver).toEqual({ deviceId: b.id, pubSign: b.pubSign, pubBox: b.pubBox });
    // The agent's coordinator (G4) finds exactly this shape: A → B, new sessions, hand-off.
    expect(onA.sender.sessionId ?? onA.receiver.sessionId).toBeUndefined();
  });

  it("a link code for another computer, or a tampered one, is refused before the challenge", async () => {
    const a = await computer("dev_a1");
    const b = await computer("dev_b1");
    const c = await computer("dev_c1");
    const spec = (await parseLinkCode(
      linkCode({
        id: "lnk_abcdefgh12345678",
        mode: "handoff",
        sender: { deviceId: b.id, pubSign: b.pubSign, pubBox: b.pubBox },
        receiver: { deviceId: c.id, pubSign: c.pubSign, pubBox: c.pubBox },
        workspaceLabel: "chalito",
        goal: "x",
        expiresAt: Date.now() + 86_400_000,
        dailyTokenBudget: 1000,
        ratePerHour: 1,
        confirm: true,
        permissionCeiling: "default",
      }),
      Date.now(),
    ))!;
    renderLinks(a.ipc);
    fireEvent.click(await screen.findByRole("button", { name: "Pegar un enlace de otra computadora…" }));
    const box = screen.getByLabelText("Código del enlace");
    fireEvent.change(box, { target: { value: linkCode(spec) } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }));
    await screen.findByText(/Ese enlace no es para esta computadora/);
    // A's id with someone else's keys: the id isn't derived from those keys, so the code is forged.
    const forged = { ...spec, receiver: { deviceId: a.id, pubSign: c.pubSign, pubBox: c.pubBox } };
    fireEvent.change(box, { target: { value: linkCode(forged) } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }));
    await screen.findByText(/no es válido o ya venció/);
    // Both ends this computer, the receiver pinned: the pin check can't be dodged by the first end.
    const me = { deviceId: a.id, pubSign: a.pubSign, pubBox: a.pubBox };
    const doubled = { ...spec, sender: me, receiver: { ...me, sessionId: "s_pinned1" } };
    fireEvent.change(box, { target: { value: linkCode(doubled) } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }));
    await waitFor(() => expect(screen.queryByText(/no es válido o ya venció/)).toBeNull());
    await screen.findByText(/Ese enlace no es para esta computadora/);
    expect(screen.queryByRole("button", { name: "Continuar" })).toBeNull();
    fireEvent.change(box, { target: { value: "chalito-link:not-json" } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }));
    await screen.findByText(/no es válido o ya venció/);
    expect(a.links.list()).toHaveLength(0);
  });

  it("errors from the agent show and make nothing: OS check failed, folder outside policy", async () => {
    const a = await computer("dev_a1", { osAuth: false });
    renderLinks(a.ipc);
    await fillNew({ workspace: "chalito", goal: "x" });
    await passChallenge();
    await screen.findByText("No se creó el enlace (no se confirmó la contraseña de la computadora).");
    expect(a.links.list()).toHaveLength(0);

    a.auth.ok = true;
    const b = await computer("dev_b1");
    // The receiver is here, so only this computer's folders are offered; a stale label is still refused.
    await fillNew({
      otherCode: deviceCode({ deviceId: b.id, pubSign: b.pubSign, pubBox: b.pubBox }),
      direction: "receive",
      workspace: "",
      goal: "x",
    });
    await screen.findByText(/Elige la carpeta/);
    const ok = await a.ipc.addLink(
      {
        id: "lnk_outofscope1234",
        mode: "handoff",
        sender: { deviceId: b.id, pubSign: b.pubSign, pubBox: b.pubBox },
        receiver: { deviceId: a.id, pubSign: a.pubSign, pubBox: a.pubBox },
        workspaceLabel: "elsewhere",
        goal: "x",
        expiresAt: Date.now() + 86_400_000,
        dailyTokenBudget: 1000,
        ratePerHour: 1,
        confirm: true,
        permissionCeiling: "default",
      },
      { confirm: true, typed: LINK_COPY.es.phrase },
    );
    expect(ok).toEqual({ ok: false, reason: "link_out_of_scope" });
    // The agent re-checks the phrase itself: a panel can't skip it.
    const here = { deviceId: a.id };
    const sameComputer = {
      id: "lnk_phrase12345678",
      mode: "handoff" as const,
      sender: here,
      receiver: here,
      workspaceLabel: "chalito",
      goal: "x",
      expiresAt: Date.now() + 86_400_000,
      dailyTokenBudget: 1000,
      ratePerHour: 1,
      confirm: true,
      permissionCeiling: "default" as const,
    };
    expect(await a.ipc.addLink(sameComputer, { confirm: true, typed: "no" })).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(await a.ipc.addLink(sameComputer, { confirm: false, typed: LINK_COPY.es.phrase })).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(a.links.list()).toHaveLength(0);
  });

  it("revoke one, revoke all; a revoked link's id can't be made again", async () => {
    const a = await computer("dev_a1");
    const make = async (goal: string) => {
      await fillNew({ workspace: "chalito", goal });
      await passChallenge();
      await screen.findByText("Enlace creado.");
      fireEvent.click(screen.getByRole("button", { name: "Listo" }));
    };
    renderLinks(a.ipc);
    await make("uno");
    await make("dos");
    await waitFor(() => expect(section().querySelectorAll("[data-link]")).toHaveLength(2));
    const first = a.links.list()[0]!;
    fireEvent.click(within(section().querySelector(`[data-link="${first.id}"]`)! as HTMLElement).getByText("Revocar"));
    await waitFor(() => expect(section().querySelectorAll("[data-link]")).toHaveLength(1));
    expect(a.links.get(first.id)).toBeUndefined();

    const { v: _v, createdAt: _c, createdBy: _b, ...again } = first;
    expect(await a.ipc.addLink(again, { confirm: true, typed: LINK_COPY.es.phrase })).toEqual({
      ok: false,
      reason: "invalid",
    });

    fireEvent.click(screen.getByRole("button", { name: "Revocar todos" }));
    await screen.findByText("No hay enlaces.");
    expect(a.links.list()).toHaveLength(0);
  });

  it("a link the cloud mirror doesn't hold yet shows as pending publish", async () => {
    const a = await computer("dev_a1");
    a.cloud.failPublishes = 1;
    renderLinks(a.ipc);
    await fillNew({ workspace: "chalito", goal: "x" });
    await passChallenge();
    await screen.findByText("Pendiente de publicar: aún no lleva nada");
  });

  it("form problems are caught in the panel: bad computer code, its own code, no goal", async () => {
    const a = await computer("dev_a1");
    renderLinks(a.ipc);
    await fillNew({ otherCode: "chalito-pc:garbage", goal: "x", workspace: "repo" });
    await screen.findByText(/El código de la otra computadora no es válido/);
    // My other computer's id with an attacker's keys: refused, and the agent refuses it too.
    const b = await computer("dev_b1");
    const evil = await computer("dev_evil");
    const forged = { deviceId: b.id, pubSign: evil.pubSign, pubBox: evil.pubBox };
    fireEvent.change(screen.getByLabelText(/Código de la otra computadora/), { target: { value: deviceCode(forged) } });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await waitFor(() => expect(screen.getAllByText(/El código de la otra computadora no es válido/)).toHaveLength(1));
    expect(
      await a.ipc.addLink(
        {
          id: "lnk_forgedpeer1234",
          mode: "handoff",
          sender: { deviceId: a.id, pubSign: a.pubSign, pubBox: a.pubBox },
          receiver: forged,
          workspaceLabel: "repo",
          goal: "x",
          expiresAt: Date.now() + 86_400_000,
          dailyTokenBudget: 1000,
          ratePerHour: 1,
          confirm: true,
          permissionCeiling: "default",
        },
        { confirm: true, typed: LINK_COPY.es.phrase },
      ),
    ).toEqual({ ok: false, reason: "link_key_mismatch" });
    fireEvent.change(screen.getByLabelText(/Código de la otra computadora/), {
      target: { value: deviceCode({ deviceId: a.id, pubSign: a.pubSign, pubBox: a.pubBox }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByText(/Ese código es de esta misma computadora/);
    fireEvent.click(screen.getByLabelText("Otro agente en esta computadora"));
    fireEvent.change(screen.getByLabelText("Para qué es el enlace"), { target: { value: " " } });
    fireEvent.change(screen.getByLabelText("Carpeta donde se trabaja"), { target: { value: "chalito" } });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await screen.findByText(/Escribe para qué es el enlace/);
    expect(a.links.list()).toHaveLength(0);
  });

  it("without the agent's IPC it says so (en)", async () => {
    renderLinks(unavailableIpc, "en");
    await screen.findByText(/local agent isn't answering/);
    expect(screen.queryByRole("button", { name: "New link…" })).toBeNull();
  });

  type Computer = Awaited<ReturnType<typeof computer>>;
  const keysOf = (c: Computer) => ({ deviceId: c.id, pubSign: c.pubSign, pubBox: c.pubBox });
  /** A link B made toward A, as B's panel would put it in a code. */
  const fromB = (a: Computer, b: Computer, over: Partial<LinkSpec> = {}): LinkSpec => ({
    id: "lnk_fromb12345678",
    mode: "handoff",
    sender: keysOf(b),
    receiver: keysOf(a),
    workspaceLabel: "chalito",
    goal: "Ñandú: revisar el código 🚀",
    expiresAt: Date.now() + 86_400_000,
    dailyTokenBudget: 9_999_999,
    ratePerHour: 59,
    confirm: false,
    permissionCeiling: "acceptEdits",
    ...over,
  });
  const paste = async (code: string) => {
    fireEvent.click(await screen.findByRole("button", { name: "Pegar un enlace de otra computadora…" }));
    fireEvent.change(screen.getByLabelText("Código del enlace"), { target: { value: code } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }));
  };

  it("before approving a pasted link the owner sees every grant: budget, rate, ceiling, pins and the peer's keys", async () => {
    const a = await computer("dev_a1");
    const b = await computer("dev_b1");
    renderLinks(a.ipc);
    await paste(linkCode(fromB(a, b, { sender: { ...keysOf(b), appId: "codex" } })));
    const card = section().querySelector('[data-form="paste"]') as HTMLElement;
    await within(card).findByText(/Hasta 9999999 tokens por día · 59 entregas por hora/);
    within(card).getByText(/Automático · permiso máximo: Puede editar archivos/);
    within(card).getByText(`Encargo: ${short(b.id)} (solo codex) → Esta computadora`);
    within(card).getByText("Ñandú: revisar el código 🚀");
    const [sign, box] = [await keyFingerprint(b.pubSign), await keyFingerprint(b.pubBox)];
    await within(card).findByText(`Código de verificación de ${short(b.id)}: ${sign} · cifrado ${box}`);
    // The same verification code shows next to B's own code in B's panel, for the owner to compare.
    cleanup();
    renderLinks(b.ipc);
    await screen.findByText(`Código de verificación de ${short(b.id)}: ${sign} · cifrado ${box}`);
  });

  it("a pasted link that pins an app or a session on this computer's end is refused", async () => {
    const a = await computer("dev_a1");
    const b = await computer("dev_b1");
    renderLinks(a.ipc);
    await paste(linkCode(fromB(a, b, { receiver: { ...keysOf(a), sessionId: "s_pinned1" } })));
    await screen.findByText(/fija una app o sesión en esta computadora/);
    fireEvent.change(screen.getByLabelText("Código del enlace"), {
      target: { value: linkCode(fromB(a, b, { receiver: { ...keysOf(a), appId: "claude-code" } })) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }));
    await screen.findAllByText(/fija una app o sesión en esta computadora/);
    expect(screen.queryByText("Continuar")).toBeNull();
    expect(a.links.list()).toHaveLength(0);
  });

  it("an expired link code is refused; an accented goal survives the code both ways", async () => {
    const a = await computer("dev_a1");
    const b = await computer("dev_b1");
    expect((await parseLinkCode(linkCode(fromB(a, b)), Date.now()))?.goal).toBe("Ñandú: revisar el código 🚀");
    renderLinks(a.ipc);
    await paste(linkCode(fromB(a, b, { expiresAt: Date.now() - 1 })));
    await screen.findByText(/no es válido o ya venció/);
    fireEvent.change(screen.getByLabelText("Código del enlace"), { target: { value: linkCode(fromB(a, b)) } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continuar" }));
    await passChallenge();
    await screen.findByText("Enlace creado.");
    expect(a.links.list()[0]).toMatchObject({ goal: "Ñandú: revisar el código 🚀", dailyTokenBudget: 9_999_999 });
  });

  it("a failed revoke says so instead of looking done", async () => {
    const a = await computer("dev_a1");
    const ipc: AgentIpc = {
      ...a.ipc,
      revokeLink: async () => {
        throw new Error("internal");
      },
      revokeAllLinks: async () => {
        throw new Error("unavailable");
      },
    };
    renderLinks(ipc);
    await fillNew({ workspace: "chalito", goal: "x" });
    await passChallenge();
    await screen.findByText("Enlace creado.");
    fireEvent.click(await screen.findByRole("button", { name: "Revocar" }));
    await screen.findByText("No se revocó (internal). Revisa la lista.");
    fireEvent.click(screen.getByRole("button", { name: "Revocar todos" }));
    await screen.findByText("No se revocó (el agente no responde). Revisa la lista.");
    expect(a.links.list()).toHaveLength(1);
    // A link already gone (revoked elsewhere) answers revoked:false.
    cleanup();
    renderLinks({ ...a.ipc, revokeLink: async () => ({ revoked: false }) });
    fireEvent.click(await screen.findByRole("button", { name: "Revocar" }));
    await screen.findByText("No se revocó (ese enlace ya no existe). Revisa la lista.");
  });

  it("one click makes one link: Confirm and Cancel lock while the agent answers", async () => {
    const a = await computer("dev_a1");
    let adds = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    renderLinks({ ...a.ipc, addLink: async (l, x) => (adds++, await gate, a.ipc.addLink(l, x)) });
    await fillNew({ workspace: "chalito", goal: "x" });
    await passChallenge();
    const confirm = screen.getByRole("button", { name: "Crear el enlace" }) as HTMLButtonElement;
    const cancel = screen.getByRole("button", { name: "Cancelar" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(true));
    expect(cancel.disabled).toBe(true);
    fireEvent.click(confirm);
    fireEvent.click(cancel);
    release();
    await screen.findByText("Enlace creado.");
    expect(adds).toBe(1);
    expect(screen.queryByText(/No se creó/)).toBeNull();
  });

  it("no keys from the agent, or unreadable folders, are said plainly; the rate is checked too", async () => {
    const a = await computer("dev_a1");
    renderLinks({ ...a.ipc, links: async () => ({ ...(await a.ipc.links()), self: null }) });
    await screen.findByText(/no dio las llaves de esta computadora/);
    expect(screen.queryByRole("button", { name: "Nuevo enlace…" })).toBeNull();
    cleanup();
    renderLinks({
      ...a.ipc,
      workspaces: async () => {
        throw new Error("internal");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo enlace…" }));
    await screen.findByText("No se pudieron leer las carpetas de esta computadora.");
    expect(screen.queryByText(/Primero agrega una carpeta/)).toBeNull();
    cleanup();
    renderLinks(a.ipc);
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo enlace…" }));
    fireEvent.change(screen.getByLabelText(/Entregas por hora/), { target: { value: "61" } });
    await fillNew({ workspace: "chalito", goal: "x" });
    await screen.findByText("Las entregas por hora van de 1 a 60.");
    expect(a.links.list()).toHaveLength(0);
  });

  it("out-of-range numbers are refused, not changed; a cross-device code can be shown again", async () => {
    const a = await computer("dev_a1");
    const b = await computer("dev_b1");
    renderLinks(a.ipc);
    fireEvent.click(await screen.findByRole("button", { name: "Nuevo enlace…" }));
    await waitFor(() => within(screen.getByLabelText("Carpeta donde se trabaja")).getByText("chalito"));
    fireEvent.change(screen.getByLabelText("Carpeta donde se trabaja"), { target: { value: "chalito" } });
    fireEvent.change(screen.getByLabelText("Para qué es el enlace"), { target: { value: "x" } });
    const days = screen.getByLabelText("Días que dura (máximo 30)");
    for (const bad of ["0", "50", ""]) {
      fireEvent.change(days, { target: { value: bad } });
      fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
      await screen.findByText("Los días van de 1 a 30.");
      expect(screen.queryByText(LINK_COPY.es.handoff[0]!)).toBeNull();
    }
    fireEvent.change(days, { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Tokens por día"), { target: { value: "" } });
    await fillNew({
      otherCode: deviceCode(keysOf(b)),
      workspace: "repo",
      goal: "x",
    });
    await screen.findByText(/Los tokens por día van de 1 a 10/);
    fireEvent.change(screen.getByLabelText("Tokens por día"), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    await passChallenge();
    const first = ((await screen.findByLabelText("Código del enlace")) as HTMLTextAreaElement).value;
    expect(a.links.list()[0]).toMatchObject({ dailyTokenBudget: 5000 });
    expect(a.links.list()[0]!.expiresAt - Date.now()).toBeLessThanOrEqual(3 * 86_400_000);
    fireEvent.click(screen.getByRole("button", { name: "Listo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ver código para la otra computadora" }));
    await screen.findByText(/por si la otra computadora aún no lo tiene/);
    expect(((await screen.findByLabelText("Código del enlace")) as HTMLTextAreaElement).value).toBe(first);
  });
});
