import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const api = readFileSync("src/triggers/api.ts", "utf-8");

describe("session reaper API", () => {
  it("registers a protected maintenance endpoint", () => {
    expect(api).toContain('registerFunction("api::session-reap"');
    expect(api).toMatch(/api_path:\s*"\/agentmemory\/session\/reap"[\s\S]*http_method:\s*"POST"/);
    expect(api).toContain('function_id: "mem::session-reap"');
  });
});
