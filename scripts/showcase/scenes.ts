import type { EmotionTag } from "@chalito/protocol";
import type { EmotionGesture } from "@chalito/avatar";
import { ROSTER, type RosterId } from "@chalito/roster";
import type { RoomEventKind } from "@chalito/protocol";

/**
 * What the Solo landing shows, rendered by the real runtime (avatar driver + card avatar) with
 * pinned seeds. Times are milliseconds from the scene start; every frame is rendered at an exact
 * time, so the output depends only on these inputs (and the software renderer), never the clock.
 */
export interface Beat {
  at: number;
  emotion?: { tag: EmotionTag; intensity: number };
  gesture?: EmotionGesture;
  sleepy?: boolean;
}

export interface Actor {
  roster: RosterId;
  /** catalog.yaml cosmetic ids (each one in its own slot). */
  cosmetics?: string[];
  /** Horizontal position in world units (0 = centre). */
  x?: number;
  beats?: Beat[];
}

export interface Scene {
  id: string;
  /** Alt text for the landing (ES/EN), describing what is actually shown. */
  alt: { es: string; en: string };
  w: number;
  h: number;
  seed: number;
  actors: Actor[];
  /**
   * A room scene (@chalito/scene's RoomScene): the actors are the members (in order), and these
   * room events (times from the scene start) drive the portal and the choreography.
   */
  room?: {
    roomId: string;
    events: { eid: string; from: number; to: number[]; kind: RoomEventKind; at: number }[];
  };
  /** Animated scenes: frames per second and length; stills render one frame at `posterAt`. */
  anim?: { fps: number; durationMs: number };
  posterAt: number;
}

export const SCENES: Scene[] = [
  {
    id: "hero-chalito",
    alt: { es: "Chalito respira, saluda y sonríe", en: "Chalito breathes, waves and smiles" },
    w: 480,
    h: 640,
    seed: 11,
    actors: [
      {
        roster: "chalito",
        beats: [
          { at: 0, emotion: { tag: "neutral", intensity: 1 } },
          { at: 900, gesture: "wave", emotion: { tag: "happy", intensity: 0.9 } },
          { at: 2600, emotion: { tag: "neutral", intensity: 1 } },
        ],
      },
    ],
    anim: { fps: 10, durationMs: 4000 },
    posterAt: 1400,
  },
  // The free roster, all six, alt text from the roster's own names and blurbs.
  ...ROSTER.map((r, i): Scene => ({
    id: `roster-${r.id}`,
    alt: { es: `${r.name.es}: ${r.blurb.es}`, en: `${r.name.en}: ${r.blurb.en}` },
    w: 300,
    h: 420,
    seed: 100 + i,
    actors: [{ roster: r.id, beats: [{ at: 0, emotion: { tag: "happy", intensity: 0.6 } }] }],
    posterAt: 1200,
  })),
  {
    id: "tryon-chalito-viking",
    alt: { es: "Chalito con el casco vikingo", en: "Chalito wearing the Viking helmet" },
    w: 400,
    h: 560,
    seed: 21,
    actors: [
      {
        roster: "chalito",
        cosmetics: ["viking_hat"],
        beats: [
          { at: 0, emotion: { tag: "neutral", intensity: 1 } },
          { at: 800, gesture: "celebrate", emotion: { tag: "excited", intensity: 0.8 } },
        ],
      },
    ],
    anim: { fps: 10, durationMs: 3000 },
    posterAt: 1300,
  },
  {
    id: "tryon-luna-crown",
    alt: { es: "Luna con corona de flores y lentes redondos", en: "Luna with a flower crown and round glasses" },
    w: 300,
    h: 420,
    seed: 22,
    actors: [
      {
        roster: "luna",
        cosmetics: ["flower_crown", "round_glasses"],
        beats: [{ at: 0, emotion: { tag: "happy", intensity: 0.7 } }],
      },
    ],
    posterAt: 1000,
  },
  {
    id: "tryon-bruno-cape",
    alt: { es: "Bruno con la capa de estrellas", en: "Bruno wearing the star cape" },
    w: 300,
    h: 420,
    seed: 23,
    actors: [
      { roster: "bruno", cosmetics: ["star_cape"], beats: [{ at: 0, emotion: { tag: "happy", intensity: 0.7 } }] },
    ],
    posterAt: 1000,
  },
  {
    id: "recharge-chalito",
    alt: { es: "Chalito se queda sin energía y bosteza", en: "Chalito runs out of energy and yawns" },
    w: 400,
    h: 560,
    seed: 31,
    actors: [
      {
        roster: "chalito",
        beats: [
          { at: 0, emotion: { tag: "tired", intensity: 0.9 }, sleepy: true },
          { at: 1000, gesture: "yawn" },
        ],
      },
    ],
    anim: { fps: 10, durationMs: 3600 },
    posterAt: 1800,
  },
  {
    id: "room-portal",
    alt: {
      es: "Luna llega a la sala por el portal y Chalito va a saludarla",
      en: "Luna arrives in the room through the portal and Chalito walks over to greet her",
    },
    w: 560,
    h: 360,
    seed: 0,
    actors: [{ roster: "chalito" }, { roster: "luna", cosmetics: ["flower_crown"] }],
    room: {
      roomId: "room_showcase",
      events: [
        { eid: "e1", from: 1, to: [], kind: "enter", at: 500 },
        { eid: "e2", from: 0, to: [1], kind: "notice", at: 3400 },
      ],
    },
    anim: { fps: 10, durationMs: 7000 },
    posterAt: 5600,
  },
];
