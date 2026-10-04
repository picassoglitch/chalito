import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RoomEventView, RoomMemberView } from "@chalito/rooms";
import type { RenderQuality, RoomSceneMember, SceneEvent } from "@chalito/scene";
import { DEFAULT_COMPANION } from "@chalito/ui";
import { RoomStage, sceneEvents, type StageScene } from "../src/room/RoomStage.js";
import { sceneMembersFor } from "../src/room/scene-members.js";

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

  it("members: the co-member directory's roster card, else the default companion", async () => {
    const dir: Record<string, string | null> = { chl_mom: "luna", chl_me: "not-a-card" };
    const db = {
      from: (t: string) => ({
        select: () => ({
          eq: async (_c: string, id: string) => ({
            data: t === "companion_directory" && id in dir ? [{ companion_id: id, avatar_thumb: dir[id] }] : [],
            error: null,
          }),
        }),
      }),
    };
    const out = await sceneMembersFor(db, [...MEMBERS, { companionId: "chl_x", role: "member", me: false }]);
    expect(out.map((m) => [m.companionId, m.avatar])).toEqual([
      ["chl_me", DEFAULT_COMPANION],
      ["chl_mom", "luna"],
      ["chl_x", DEFAULT_COMPANION],
    ]);
  });
});
