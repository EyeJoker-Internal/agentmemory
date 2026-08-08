import { describe, expect, it } from "vitest";
import { rankSemanticForProject } from "../src/functions/semantic-ranking.js";
import type { SemanticMemory } from "../src/types.js";

function semantic(
  id: string,
  project: string | undefined,
  updatedAt: string,
  strength = 1,
): SemanticMemory {
  return {
    id,
    fact: `fact ${id}`,
    confidence: 0.9,
    sourceSessionIds: [],
    sourceMemoryIds: [],
    ...(project ? { project } : {}),
    accessCount: 0,
    lastAccessedAt: updatedAt,
    strength,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("semantic project ranking", () => {
  const rows = [
    semantic("legacy-new", undefined, "2026-08-08T03:00:00.000Z", 2),
    semantic("other", "other-project", "2026-08-08T04:00:00.000Z", 10),
    semantic("scoped-old", "portal", "2026-08-08T01:00:00.000Z", 1),
    semantic("legacy-old", undefined, "2026-08-08T00:00:00.000Z", 9),
    semantic("scoped-new", "portal", "2026-08-08T02:00:00.000Z", 3),
  ];

  it("ranks project-scoped facts before legacy fallback facts", () => {
    const result = rankSemanticForProject(rows, {
      project: "portal",
      includeLegacy: true,
    });

    expect(result.rows.map((row) => row.id)).toEqual([
      "scoped-new",
      "scoped-old",
      "legacy-new",
      "legacy-old",
    ]);
    expect(result.scoped).toBe(2);
    expect(result.legacy).toBe(2);
    expect(result.excludedOtherProjects).toBe(1);
  });

  it("can omit legacy fallback facts", () => {
    const result = rankSemanticForProject(rows, {
      project: "portal",
      includeLegacy: false,
    });

    expect(result.rows.map((row) => row.id)).toEqual([
      "scoped-new",
      "scoped-old",
    ]);
    expect(result.legacy).toBe(0);
  });

  it("preserves the full corpus when no project is requested", () => {
    const result = rankSemanticForProject(rows, {});

    expect(result.rows).toHaveLength(rows.length);
    expect(new Set(result.rows.map((row) => row.id))).toEqual(
      new Set(rows.map((row) => row.id)),
    );
  });
});
