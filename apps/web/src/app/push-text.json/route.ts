import es from "@chalito/ui/messages/es.json";
import en from "@chalito/ui/messages/en.json";

export const dynamic = "force-static";

/**
 * The service worker's notification text (public/sw.js), from the message catalogs like every
 * other string. Static: built once, cached by the worker.
 */
export const GET = () => Response.json({ es: es.live.push.notification, en: en.live.push.notification });
