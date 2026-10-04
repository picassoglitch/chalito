/**
 * Scripted fake agent sessions, for tests ONLY (`@chalito/adapters/testing`). They are kept out of
 * the production entry points (".", "./claude-code", "./codex") so the daemon can't wire a fake
 * session by accident; test/no-fakes-in-prod.test.ts enforces that.
 */
export { fakeClaudeCode } from "./claude-code/fake.js";
export type { FakeStep, FakeRun } from "./claude-code/fake.js";
export { fakeCodex } from "./codex/fake.js";
export type { FakeCodexStep, FakeCodexRun } from "./codex/fake.js";
