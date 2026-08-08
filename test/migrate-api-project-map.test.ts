import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const api = readFileSync("src/triggers/api.ts", "utf-8");

describe("project-scope migration API", () => {
  it("forwards explicit project mappings and ambiguous-row policy", () => {
    const migrateBlock = api.slice(
      api.indexOf('sdk.registerFunction("api::migrate"'),
      api.indexOf('sdk.registerFunction("api::evict"'),
    );
    expect(migrateBlock).toContain("projectMap");
    expect(migrateBlock).toContain("includeAmbiguous");
    expect(migrateBlock).toMatch(/\{ projectMap \}/);
    expect(migrateBlock).toMatch(/includeAmbiguous:\s*req\.body\.includeAmbiguous/);
  });
});
