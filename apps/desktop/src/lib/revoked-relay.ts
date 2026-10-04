/**
 * R-L14 on the desktop: the panel's LiveStore is the one that hears this device was revoked.
 * Relay it ONCE to the other windows (the room window then forgets keys and decrypted events),
 * whether the store is already revoked when the panel connects or goes revoked later.
 */
export const relayRevoked = (
  live: { getSnapshot(): { status: string }; subscribe(l: () => void): () => void },
  send: () => Promise<void>,
): (() => void) => {
  let sent = false;
  const check = () => {
    if (sent || live.getSnapshot().status !== "revoked") return;
    sent = true;
    void send().catch(() => undefined);
  };
  check();
  return live.subscribe(check);
};
