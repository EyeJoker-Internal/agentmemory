import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const stopHook = readFileSync("src/hooks/stop.ts", "utf-8");
const sessionEndHook = readFileSync("src/hooks/session-end.ts", "utf-8");

describe("Claude Code lifecycle hooks", () => {
  it("does not finalize or summarize a session on the per-turn Stop hook", () => {
    expect(stopHook).not.toContain("/agentmemory/summarize");
    expect(stopHook).not.toContain("/agentmemory/session/end");
  });

  it("finalizes the session only from SessionEnd", () => {
    expect(sessionEndHook).toContain("/agentmemory/session/end");
  });
});
