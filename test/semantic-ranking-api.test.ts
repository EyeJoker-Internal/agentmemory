import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const api = readFileSync("src/triggers/api.ts", "utf8");

describe("semantic archive retrieval and watermark status REST wiring", () => {
  it("supports project-ranked semantic retrieval with optional legacy fallback", () => {
    expect(api).toContain("rankSemanticForProject");
    expect(api).toContain('req.query_params?.["project"]');
    expect(api).toContain('req.query_params?.["includeLegacy"]');
    expect(api).toContain("retrievalScope");
  });

  it("registers the semantic watermark status endpoint", () => {
    expect(api).toContain('registerFunction("api::semantic-status"');
    expect(api).toContain('function_id: "mem::semantic-status"');
    expect(api).toContain('api_path: "/agentmemory/semantic/status"');
  });
});
