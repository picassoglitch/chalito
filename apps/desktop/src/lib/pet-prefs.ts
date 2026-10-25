const WALK_KEY = "chalito-desktop-pet-walk";

/** Whether the pet takes short walks along the taskbar (this device only; on unless turned off). */
export const loadPetWalk = (storage: Pick<Storage, "getItem"> | null = safeLocal()): boolean => {
  try {
    return storage?.getItem(WALK_KEY) !== "0";
  } catch {
    return true;
  }
};

export const savePetWalk = (on: boolean, storage: Pick<Storage, "setItem"> | null = safeLocal()): void => {
  try {
    storage?.setItem(WALK_KEY, on ? "1" : "0");
  } catch {
    // Not persisted; the pet keeps its current behaviour.
  }
};

function safeLocal(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
