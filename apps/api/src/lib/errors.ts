import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Throws a JSON error `{ error, message? }` with the given status. */
export const fail = (status: ContentfulStatusCode, error: string, message?: string): never => {
  throw new HTTPException(status, {
    res: new Response(JSON.stringify({ error, ...(message ? { message } : {}) }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  });
};
