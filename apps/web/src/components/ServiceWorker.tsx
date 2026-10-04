"use client";
import { useEffect } from "react";

/** Registers the service worker (installability now; Web Push with VAPID later, D-050). */
export const ServiceWorker = () => {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }
  }, []);
  return null;
};
