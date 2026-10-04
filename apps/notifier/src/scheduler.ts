/** Ladder ticks: one HTTP task per (user, ladder, time) that POSTs {uid, nid} back to /tasks/tick. */
export interface Scheduler {
  schedule(uid: string, nid: string, at: number): Promise<void>;
  /** Removes the task for that exact time; missing tasks are fine (ticks are idempotent anyway). */
  cancel(uid: string, nid: string, at: number): Promise<void>;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160);
export const taskId = (uid: string, nid: string, at: number) => `tick-${safe(uid)}-${safe(nid)}-${at}`;

/**
 * Cloud Tasks over REST (v2). The task carries an OIDC token for `serviceAccountEmail`, which
 * the tick endpoint verifies. Task names are deterministic, so a duplicate schedule is a 409
 * and a cancel needs only the time it was scheduled for.
 */
export const cloudTasksScheduler = (opts: {
  project: string;
  location: string;
  queue: string;
  tickUrl: string;
  serviceAccountEmail: string;
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
}): Scheduler => {
  const queuePath = `projects/${opts.project}/locations/${opts.location}/queues/${opts.queue}`;
  const call = async (method: string, path: string, body?: unknown) =>
    (opts.fetch ?? fetch)(`https://cloudtasks.googleapis.com/v2/${path}`, {
      method,
      headers: { authorization: `Bearer ${await opts.getAccessToken()}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return {
    async schedule(uid, nid, at) {
      const res = await call("POST", `${queuePath}/tasks`, {
        task: {
          name: `${queuePath}/tasks/${taskId(uid, nid, at)}`,
          scheduleTime: new Date(at).toISOString(),
          httpRequest: {
            httpMethod: "POST",
            url: opts.tickUrl,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify({ uid, nid })).toString("base64"),
            oidcToken: { serviceAccountEmail: opts.serviceAccountEmail, audience: opts.tickUrl },
          },
        },
      });
      if (!res.ok && res.status !== 409) throw new Error(`cloud tasks schedule failed: ${res.status}`);
    },
    async cancel(uid, nid, at) {
      const res = await call("DELETE", `${queuePath}/tasks/${taskId(uid, nid, at)}`);
      if (!res.ok && res.status !== 404) throw new Error(`cloud tasks cancel failed: ${res.status}`);
    },
  };
};
