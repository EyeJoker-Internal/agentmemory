import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const api = readFileSync("src/triggers/api.ts", "utf-8");

describe("sessions API pagination", () => {
  it("uses the bounded session-page selector", () => {
    expect(api).toContain("selectSessionsPage");
  });

  it("returns pagination and malformed-row metadata", () => {
    expect(api).toMatch(/body:\s*\{[\s\S]*sessions[,\s][\s\S]*total:[\s\S]*malformedCount:[\s\S]*limit:[\s\S]*offset:/);
  });
});
