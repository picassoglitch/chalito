import { CustomCardSource } from "@chalito/scene/custom-card";
import type { AvatarApi } from "./avatar";

/**
 * The person's own custom companion card (GET /v1/avatar/companion), kept with working signed
 * URLs for every place that draws their companion: the room (their own companion only), the store
 * preview and the settings picker. URLs are re-fetched five minutes before they expire, when a
 * drawing fails to load, and after "use" or a roster pick. Without a card (or before the api
 * answers) the roster avatar is drawn.
 */
export const myCardSource = (avatar: AvatarApi): CustomCardSource =>
  new CustomCardSource({
    fetch: async () => {
      const c = await avatar.companion();
      if (c === "error") throw new Error("companion card unavailable");
      return c;
    },
  });
