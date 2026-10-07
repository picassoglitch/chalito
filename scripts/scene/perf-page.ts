/**
 * Browser side of scripts/scene-perf.ts: RoomScene at a fixed quality on a 640×400 canvas, all
 * six roster companions in a lively room (portal entries and conversations), on its own loop.
 */
import { ORIGINAL_IDS } from "@chalito/roster";
import { RoomScene, type QualityLevel, type SceneEvent } from "@chalito/scene";

const run = async (quality: QualityLevel, ms: number) => {
  const canvas = document.querySelector("canvas")!;
  canvas.style.width = "640px";
  canvas.style.height = "400px";
  const t0 = Date.now();
  const scene = new RoomScene({ canvas, roomId: "room_perf", assetBase: "/roster/", quality });
  const ids = ORIGINAL_IDS.map((r, i) => `chl_perf${String.fromCharCode(97 + i).repeat(22)}`);
  scene.setMembers(ORIGINAL_IDS.map((avatar, i) => ({ companionId: ids[i]!, avatar })));
  const events: SceneEvent[] = [];
  ids.forEach((id, i) => events.push({ eid: `in${i}`, fromCompanionId: id, to: [], kind: "enter", t: t0 + i * 300 }));
  for (let k = 0; k < 12; k++)
    events.push({
      eid: `m${k}`,
      fromCompanionId: ids[k % 6]!,
      to: [ids[(k + 2) % 6]!],
      kind: "notice",
      t: t0 + 1000 + k * 700,
    });
  scene.pushEvents(events);
  await scene.ready();
  scene.start();
  const start = performance.now();
  const before = scene.frames;
  await new Promise((r) => setTimeout(r, ms));
  const loopFps = ((scene.frames - before) * 1000) / (performance.now() - start);
  scene.stop();
  // Throughput: frames the scene can draw per second, waiting for the GPU each time.
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const px = new Uint8Array(4);
  const n = 90;
  const s2 = performance.now();
  for (let i = 0; i < n; i++) {
    scene.renderAt(t0 + 2000 + i * 33);
    gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }
  const drawFps = (n * 1000) / (performance.now() - s2);
  const level = scene.level;
  scene.dispose();
  return { quality, level, loopFps, drawFps };
};

(window as unknown as { __perf: { run: typeof run } }).__perf = { run };
