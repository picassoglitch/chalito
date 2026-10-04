import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RoomEventView, RoomMemberView } from "@chalito/rooms";
import type { RenderQuality, RoomSceneMember, SceneEvent } from "@chalito/scene";
import { DEFAULT_COMPANION } from "@chalito/ui";
import { RoomStage, sceneEvents, type StageScene } from "../src/room/RoomStage.js";
import { catalogLoader, sceneMembersFor } from "../src/room/scene-members.js";

afterEach(cleanup);

const ev = (eid: string, kind: string, text: string | null, to: string[] = []): RoomEventView => ({
  eid,
  from: "chl_mom",
  to,
  kind,
  t: 1000,
  text,
  promoted: false,
  expiresAt: null,
});
const MEMBERS: RoomMemberView[] = [
  { companionId: "chl_me", role: "member", me: true },
  { companionId: "chl_mom", role: "owner", me: false },
];

const fakeScene = () => {
  const calls: unknown[][] = [];
  const s: StageScene = {
    setMembers: (m) => void calls.push(["members", m]),
    pushEvents: (e) => void calls.push(["events", e]),
    setQuality: (q) => void calls.push(["quality", q]),
    start: () => void calls.push(["start"]),
    stop: () => void calls.push(["stop"]),
    dispose: () => void calls.push(["dispose"]),
  };
  return { s, calls };
};

describe("room scene in the room window", () => {
  it("sceneEvents: metadata only (never the text), known kinds only, `to` kept", () => {
    const out = sceneEvents([ev("e1", "notice", "secreto", ["chl_me"]), ev("e2", "bogus", "x")]);
    expect(out).toEqual([{ eid: "e1", fromCompanionId: "chl_mom", to: ["chl_me"], kind: "notice", t: 1000 }]);
    expect(JSON.stringify(out)).not.toContain("secreto");
  });

  it("creates the scene with the setting's quality, feeds members and events, follows the slider, stops when the room ends", async () => {
    const f = fakeScene();
    let quality: RenderQuality = "medio";
    const created: RenderQuality[] = [];
    const resolved: RoomSceneMember[] = [{ companionId: "chl_mom", avatar: "luna" }];
    const props = {
      roomId: "r1",
      members: MEMBERS,
      events: [ev("e1", "notice", "hola")],
      resolveMembers: async () => resolved,
      createScene: (_c: HTMLCanvasElement, q: RenderQuality) => (created.push(q), f.s),
      quality: () => quality,
    };
    const { rerender, unmount } = render(<RoomStage {...props} running />);
    await act(async () => undefined);
    expect(created).toEqual(["medio"]);
    expect(f.calls).toContainEqual(["members", resolved]);
    expect(f.calls).toContainEqual([
      "events",
      [{ eid: "e1", fromCompanionId: "chl_mom", to: [], kind: "notice", t: 1000 }],
    ]);
    expect(f.calls).toContainEqual(["start"]);
    quality = "alto";
    act(() => void window.dispatchEvent(new Event("storage")));
    expect(f.calls).toContainEqual(["quality", "alto"]);
    rerender(<RoomStage {...props} running={false} />);
    expect(f.calls.at(-1)).toEqual(["stop"]);
    unmount();
    expect(f.calls.at(-1)).toEqual(["dispose"]);
  });

  it("no WebGL: the stage renders nothing and doesn't throw", () => {
    expect(() =>
      render(
        <RoomStage
          roomId="r1"
          members={MEMBERS}
          events={[] as SceneEvent[] as never}
          running
          resolveMembers={async () => []}
          createScene={() => {
            throw new Error("no webgl");
          }}
          quality={() => "auto"}
        />,
      ),
    ).not.toThrow();
  });

  it("members: the directory's roster card (else the default) and equipped cosmetics placed from the catalog", async () => {
    const dir: Record<string, { avatar_thumb: string | null; equipped: string[] }> = {
      chl_mom: { avatar_thumb: "luna", equipped: ["flower_crown", "unknown_item"] },
      chl_me: { avatar_thumb: "not-a-card", equipped: [] },
    };
    const db = {
      from: (t: string) => ({
        select: (cols: string) => ({
          eq: async (_c: string, id: string) => {
            expect(cols).toBe("companion_id, avatar_thumb, equipped");
            return {
              data: t === "companion_directory" && id in dir ? [{ companion_id: id, ...dir[id] }] : [],
              error: null,
            };
          },
        }),
      }),
    };
    let fetches = 0;
    const catalog = catalogLoader(async () => {
      fetches++;
      return {
        items: [
          {
            id: "flower_crown",
            slot: "head",
            art: "cosmetics/flower_crown.webp",
            card: { width: 0.44, pivot: [0.5, 0.62] },
          },
          { id: "broken" },
        ],
      };
    });
    const out = await sceneMembersFor(db, [...MEMBERS, { companionId: "chl_x", role: "member", me: false }], catalog);
    expect(out).toEqual([
      { companionId: "chl_me", avatar: DEFAULT_COMPANION, presence: "online" },
      {
        companionId: "chl_mom",
        avatar: "luna",
        presence: "online",
        cosmetics: [{ slot: "head", art: "cosmetics/flower_crown.webp", card: { width: 0.44, pivot: [0.5, 0.62] } }],
      },
      { companionId: "chl_x", avatar: DEFAULT_COMPANION, presence: "online" },
    ]);
    await sceneMembersFor(db, MEMBERS, catalog);
    expect(fetches).toBe(1);
  });

  it("a failed catalog fetch renders members without cosmetics and is retried next time", async () => {
    let n = 0;
    const catalog = catalogLoader(async () => {
      if (++n === 1) throw new Error("offline");
      return { items: [] };
    });
    expect((await catalog()).size).toBe(0);
    await catalog();
    expect(n).toBe(2);
  });
});
