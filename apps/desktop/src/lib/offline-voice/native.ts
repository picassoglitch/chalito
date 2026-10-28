import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Recorder } from "./controller.js";

const PTT = "chalito://voice-ptt";

/** The push-to-talk hotkey, held by the native side only while offline voice is on. */
export interface VoiceHotkey {
  /** null releases it. Rejects with the native reason when the OS won't give it. */
  set(accel: string | null): Promise<void>;
  onPtt(cb: (down: boolean) => void): Promise<() => void>;
}

export const tauriHotkey: VoiceHotkey = {
  set: (accel) => invoke("set_voice_hotkey", { accel }),
  onPtt: (cb) => listen<string>(PTT, (e) => cb(e.payload === "down")),
};

export const noHotkey: VoiceHotkey = {
  set: () => Promise.resolve(),
  onPtt: () => Promise.resolve(() => undefined),
};

export const voiceHotkey = (): VoiceHotkey => (isTauri() ? tauriHotkey : noHotkey);

type GetUserMedia = () => Promise<MediaStream>;
const defaultMic: GetUserMedia = () =>
  navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });

/** Asked once, when the person turns the mode on; the stream closes right away. */
export const askMicPermission = async (getUserMedia: GetUserMedia = defaultMic): Promise<void> => {
  const s = await getUserMedia();
  for (const t of s.getTracks()) t.stop();
};

/** The mic through Web Audio. The samples stay in this webview until they go to the local engine. */
export const micRecorder = (getUserMedia: GetUserMedia = defaultMic): Recorder => ({
  async start(onFrame) {
    const stream = await getUserMedia();
    let ctx: AudioContext | null = null;
    try {
      const c = (ctx = new AudioContext());
      // A global hotkey isn't a user gesture: the context may start suspended, and resume() may never settle.
      await Promise.race([c.resume(), new Promise((ok) => setTimeout(ok, 1000))]);
      const src = c.createMediaStreamSource(stream);
      // ScriptProcessor: AudioWorklet isn't in every WebKitGTK the app runs on.
      const node = c.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)), c.sampleRate);
      src.connect(node);
      node.connect(c.destination);
      return () => {
        node.onaudioprocess = null;
        node.disconnect();
        src.disconnect();
        for (const t of stream.getTracks()) t.stop();
        void c.close();
      };
    } catch (e) {
      for (const t of stream.getTracks()) t.stop();
      void ctx?.close();
      throw e;
    }
  },
});
