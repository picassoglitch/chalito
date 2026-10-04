import sodium from "libsodium-wrappers";

let readyPromise: Promise<typeof sodium> | undefined;

/** Resolves once libsodium's wasm is initialised. Every public function awaits it. */
export const ready = (): Promise<typeof sodium> => {
  readyPromise ??= sodium.ready.then(() => sodium);
  return readyPromise;
};
