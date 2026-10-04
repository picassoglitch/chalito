/**
 * The Chalyb hub consumption contract (ADR 0016), as far as voice needs it: admit before any
 * managed spend, report usage while it runs, settle at the end. The real HTTP client arrives in
 * M12; until then StubHubUsage admits everything and logs what it would meter.
 */
export type MeterKind = "voice.seconds";

export interface HubUsage {
  admit(p: {
    owner: string;
    kind: MeterKind;
    class: "stream";
    sourceId: string;
  }): Promise<{ admitted: true; admissionId: string } | { admitted: false; reason: string }>;
  /** Reports usage for an admission; `continue: false` means the balance ran out. */
  record(p: {
    owner: string;
    admissionId: string;
    kind: MeterKind;
    quantity: number;
    sourceId: string;
  }): Promise<{ continue: boolean }>;
  settle(p: { owner: string; admissionId: string }): Promise<void>;
}

export class StubHubUsage implements HubUsage {
  readonly recorded: { owner: string; admissionId: string; kind: MeterKind; quantity: number; sourceId: string }[] = [];
  readonly settled: string[] = [];
  constructor(private readonly log: (msg: string, meta: Record<string, unknown>) => void = () => {}) {}
  async admit(p: { owner: string; kind: MeterKind; class: "stream"; sourceId: string }) {
    this.log("hub.admit (stub)", p);
    return { admitted: true as const, admissionId: `adm_${p.sourceId}` };
  }
  async record(p: { owner: string; admissionId: string; kind: MeterKind; quantity: number; sourceId: string }) {
    this.recorded.push(p);
    this.log("hub.record (stub)", p);
    return { continue: true };
  }
  async settle(p: { owner: string; admissionId: string }) {
    this.settled.push(p.admissionId);
    this.log("hub.settle (stub)", p);
  }
}
