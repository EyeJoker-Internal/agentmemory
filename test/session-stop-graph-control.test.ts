import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const events = readFileSync("src/triggers/events.ts", "utf-8");

describe("session stop graph control", () => {
  it("supports skipping graph extraction for stale-session reaping", () => {
    const stopped = events.slice(
      events.indexOf('sdk.registerFunction("event::session::stopped"'),
      events.indexOf('sdk.registerFunction("event::session::ended"'),
    );
    expect(stopped).toContain("skipGraph?: boolean");
    expect(stopped).toMatch(/if\s*\(!data\.skipGraph\s*&&/);
  });
});
