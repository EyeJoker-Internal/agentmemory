import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = "deploy/operations/agentmemory-quality-audit.py";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

describe("AgentMemory weekly quality audit script", () => {
  it("reports only aggregate quality metrics and persists a secure baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmemory-quality-audit-"));
    const state = join(dir, "state.json");
    const sourceIds = ["s1", "s2"];
    writeJson(join(dir, "health.json"), { status: "healthy" });
    writeJson(join(dir, "semantic.json"), {
      semantic: [
        {
          id: "a",
          fact: "Portal uses SSO authentication.",
          project: "portal",
          sourceSessionIds: sourceIds,
        },
        {
          id: "b",
          fact: "Portal uses SSO authentication!",
          sourceSessionIds: sourceIds,
        },
        {
          id: "c",
          fact: "soriQ uses AutoEQ.",
          sourceSessionIds: ["s3"],
        },
      ],
    });
    writeJson(join(dir, "status.json"), {
      semantic: { total: 3, projectScoped: 1, legacyUnscoped: 2 },
      projects: [
        {
          project: "portal",
          totalSummaries: 7,
          processedSummaries: 5,
          pendingSummaries: 2,
        },
      ],
    });
    writeJson(join(dir, "diagnostics.json"), {
      summary: { pass: 15, warn: 0, fail: 0, fixable: 0 },
    });
    writeJson(join(dir, "reaper.json"), { candidateCount: 0 });

    const first = spawnSync(
      "python3",
      [script, "--fixture-dir", dir, "--state-file", state],
      { encoding: "utf8" },
    );
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("health=healthy");
    expect(first.stdout).toContain("semantic=3");
    expect(first.stdout).toContain("scoped=1 legacy=2");
    expect(first.stdout).toContain("exactGroups=1");
    expect(first.stdout).toContain("sameSourcePairs=1");
    expect(first.stdout).not.toContain("Portal uses SSO");
    expect(statSync(state).mode & 0o777).toBe(0o600);

    const persisted = JSON.parse(readFileSync(state, "utf8"));
    expect(persisted.semanticCount).toBe(3);

    const second = spawnSync(
      "python3",
      [script, "--fixture-dir", dir, "--state-file", state],
      { encoding: "utf8" },
    );
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("delta=+0");
  });
});
