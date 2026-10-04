"use client";
import { useEffect, useRef, useState } from "react";
import type { RoomScene, RoomSceneMember, SceneEvent } from "@chalito/scene";

/**
 * The room's 3D stage (-8d's @chalito/scene): companions wander, react to who speaks to whom and
 * teleport on enter/leave. It gets METADATA only (who, to whom, kind, when), never content, and
 * takes no input. Loaded on demand so three.js stays out of every other route; without WebGL the
 * stage simply isn't shown.
 */
export const RoomStage = ({
  roomId,
  members,
  events,
  label,
}: {
  roomId: string;
  members: readonly RoomSceneMember[];
  events: readonly SceneEvent[];
  label: string;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<RoomScene | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { RoomScene } = await import("@chalito/scene");
        if (!alive || !canvas.current) return;
        const s = new RoomScene({ canvas: canvas.current, roomId, assetBase: "/roster/", quality: "auto" });
        scene.current = s;
        s.start();
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      scene.current?.dispose();
      scene.current = null;
    };
  }, [roomId]);

  useEffect(() => scene.current?.setMembers([...members]), [members]);
  useEffect(() => scene.current?.pushEvents([...events]), [events]);

  if (failed) return null;
  return (
    <canvas
      ref={canvas}
      data-testid="room-stage"
      role="img"
      aria-label={label}
      className="aspect-[16/9] w-full rounded-xl bg-gradient-to-b from-sky-50 to-emerald-50"
    />
  );
};
