import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const api = readFileSync("src/triggers/api.ts", "utf8");
const index = readFileSync("src/index.ts", "utf8");

describe("semantic merge REST wiring", () => {
  it("registers a confirmation-gated semantic merge endpoint", () => {
    expect(api).toContain('registerFunction("api::semantic-merge"');
    expect(api).toContain('function_id: "mem::semantic-merge"');
    expect(api).toContain('api_path: "/agentmemory/semantic/merge"');
    expect(api).toContain('confirm: req.body.confirm');
    expect(api).toContain('requireConfiguredSecret(secret, "semantic merge")');
  });

  it("registers the semantic merge function with the worker", () => {
    expect(index).toContain("registerSemanticMergeFunction");
  });
});
