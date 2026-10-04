import { useEffect, useRef, useState } from "react";
import { RoomEventKind } from "@chalito/protocol";
import type { RoomEventView, RoomMemberView } from "@chalito/rooms";
import { RoomScene, type RenderQuality, type RoomSceneMember, type SceneEvent } from "@chalito/scene";
import { loadSettings } from "../lib/settings-local.js";

export interface StageScene {
  setMembers(m: readonly RoomSceneMember[]): void;
  pushEvents(e: readonly SceneEvent[]): void;
  setQuality(q: RenderQuality): void;
  start(): void;
  stop(): void;
  dispose(): void;
}

/** Metadata only: the scene never gets an event's text. */
export const sceneEvents = (events: readonly RoomEventView[]): SceneEvent[] =>
  events.flatMap((e) => {
    const kind = RoomEventKind.safeParse(e.kind);
    return kind.success ? [{ eid: e.eid, fromCompanionId: e.from, to: e.to, kind: kind.data, t: e.t }] : [];
  });

/** The room's 3D/card scene (M11, @chalito/scene). Nothing in it is interactive or writes anything. */
export const RoomStage = ({
  roomId,
  members,
  events,
  running,
  resolveMembers,
  createScene = (canvas, quality) => new RoomScene({ canvas, roomId, assetBase: "/roster/", quality }),
  quality: qualityOf = () => loadSettings().renderQuality,
}: {
  roomId: string;
  members: readonly RoomMemberView[];
  events: readonly RoomEventView[];
  /** False once the room ended: the scene stops. */
  running: boolean;
  resolveMembers: (m: readonly RoomMemberView[]) => Promise<RoomSceneMember[]>;
  createScene?: (canvas: HTMLCanvasElement, quality: RenderQuality) => StageScene;
  quality?: () => RenderQuality;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<StageScene | null>(null);

  useEffect(() => {
    if (!canvas.current) return;
    let s: StageScene;
    try {
      s = createScene(canvas.current, qualityOf());
    } catch {
      return; // No WebGL: the feed below still works.
    }
    setScene(s);
    // The same quality setting as the pet: follow the panel's changes (shared localStorage).
    const onStorage = () => s.setQuality(qualityOf());
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      s.dispose();
      setScene(null);
    };
  }, [roomId, createScene, qualityOf]);

  useEffect(() => {
    if (!scene) return;
    let alive = true;
    void resolveMembers(members).then(
      (m) => alive && scene.setMembers(m),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [scene, members, resolveMembers]);

  useEffect(() => scene?.pushEvents(sceneEvents(events)), [scene, events]);

  useEffect(() => {
    if (!scene) return;
    if (running) scene.start();
    else scene.stop();
  }, [scene, running]);

  return <canvas ref={canvas} className="room-stage" aria-hidden="true" />;
};
