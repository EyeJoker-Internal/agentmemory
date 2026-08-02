import { describe, it, expect } from "vitest";
import { parseJsonlText } from "../src/replay/jsonl-parser.js";
// @ts-expect-error plain .mjs module without type declarations
import { configFromEnv } from "../integrations/filesystem-watcher/watcher.mjs";

// Project-scope parity: every capture surface must resolve `project` the same
// way the hooks do (env override, git toplevel basename, cwd basename), or the
// same repo fragments into per-agent memory buckets that never cross-recall.

function transcriptLine(cwd: string): string {
  return JSON.stringify({
    type: "user",
    uuid: "u1",
    sessionId: "sess-parity",
    timestamp: "2026-08-01T10:00:00.000Z",
    cwd,
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
}

describe("replay deriveProject (via parseJsonlText)", () => {
  it("uses the basename of a posix cwd", () => {
    const parsed = parseJsonlText(transcriptLine("/home/dev/myrepo"));
    expect(parsed.project).toBe("myrepo");
  });

  it("uses the basename of a Windows cwd instead of the whole raw path", () => {
    const parsed = parseJsonlText(transcriptLine("C:\\Users\\dev\\myrepo"));
    expect(parsed.project).toBe("myrepo");
  });

  it("handles mixed separators", () => {
    const parsed = parseJsonlText(transcriptLine("C:\\Users\\dev/myrepo"));
    expect(parsed.project).toBe("myrepo");
  });
});

describe("fs-watcher configFromEnv project override", () => {
  it("prefers the canonical AGENTMEMORY_PROJECT_NAME", () => {
    const cfg = configFromEnv({
      AGENTMEMORY_FS_WATCH: "/tmp",
      AGENTMEMORY_PROJECT_NAME: "canonical-name",
      AGENTMEMORY_PROJECT: "legacy-name",
    });
    expect(cfg.project).toBe("canonical-name");
  });

  it("falls back to the deprecated AGENTMEMORY_PROJECT alias", () => {
    const cfg = configFromEnv({
      AGENTMEMORY_FS_WATCH: "/tmp",
      AGENTMEMORY_PROJECT: "legacy-name",
    });
    expect(cfg.project).toBe("legacy-name");
  });

  it("is null when neither is set (watcher derives from the root basename)", () => {
    const cfg = configFromEnv({ AGENTMEMORY_FS_WATCH: "/tmp" });
    expect(cfg.project).toBeNull();
  });
});
