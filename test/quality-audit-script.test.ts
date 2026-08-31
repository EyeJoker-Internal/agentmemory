import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";

const script = "deploy/operations/agentmemory-quality-audit.py";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

function runScript(args: string[], env: NodeJS.ProcessEnv): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn("python3", [script, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
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
          project: "portal",
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

  it("parses a critical health payload returned with HTTP 503", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmemory-quality-audit-http-"));
    const state = join(dir, "state.json");
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/agentmemory/health") {
        response.statusCode = 503;
        response.end(JSON.stringify({ status: "critical", health: { status: "critical" } }));
        return;
      }
      if (request.url === "/agentmemory/semantic") {
        response.end(JSON.stringify({ semantic: [] }));
        return;
      }
      if (request.url === "/agentmemory/semantic/status") {
        response.end(JSON.stringify({
          semantic: { total: 0, projectScoped: 0, legacyUnscoped: 0 },
          projects: [],
        }));
        return;
      }
      if (request.url === "/agentmemory/diagnostics") {
        response.end(JSON.stringify({ summary: { pass: 15, warn: 0, fail: 0 } }));
        return;
      }
      if (request.url === "/agentmemory/session/reap") {
        response.end(JSON.stringify({ candidateCount: 0 }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    try {
      const result = await runScript(
        ["--state-file", state],
        {
          ...process.env,
          AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
          AGENTMEMORY_SECRET: "test-secret",
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("health=critical");
      expect(result.stdout).toContain("warnings=health");
      expect(result.stdout).not.toContain("ERROR=HTTPError");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
    }
  });

  it("does not flag an exact fact preserved in legacy and project scopes", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmemory-quality-audit-scope-"));
    const state = join(dir, "state.json");
    writeJson(join(dir, "health.json"), { status: "healthy" });
    writeJson(join(dir, "semantic.json"), {
      semantic: [
        { id: "legacy", fact: "Shared historical fact.", sourceSessionIds: ["s1"] },
        {
          id: "scoped",
          fact: "Shared historical fact.",
          project: "agentmemory",
          sourceSessionIds: ["s2"],
        },
      ],
    });
    writeJson(join(dir, "status.json"), {
      semantic: { total: 2, projectScoped: 1, legacyUnscoped: 1 },
      projects: [],
    });
    writeJson(join(dir, "diagnostics.json"), {
      summary: { pass: 15, warn: 0, fail: 0, fixable: 0 },
    });
    writeJson(join(dir, "reaper.json"), { candidateCount: 0 });

    const result = spawnSync(
      "python3",
      [script, "--fixture-dir", dir, "--state-file", state],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });
});
