import { describe, expect, it } from "vitest";
import {
  findAbandonedSessions,
  selectSessionsPage,
} from "../src/functions/session-maintenance.js";
import type { Session } from "../src/types.js";

function session(
  id: string,
  startedAt: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    project: "project-a",
    cwd: "/tmp/project-a",
    startedAt,
    status: "completed",
    observationCount: 1,
    ...overrides,
  };
}

describe("session maintenance", () => {
  it("returns a bounded newest-first page and filters malformed legacy rows", () => {
    const rows: Array<Session | Record<string, unknown>> = [
      { status: "completed", endedAt: "2026-07-05T00:00:00.000Z" },
      ...Array.from({ length: 25 }, (_, i) =>
        session(`s${i}`, `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
      ),
    ];

    const result = selectSessionsPage(rows, {});

    expect(result.sessions).toHaveLength(20);
    expect(result.sessions[0].id).toBe("s24");
    expect(result.sessions[19].id).toBe("s5");
    expect(result.total).toBe(25);
    expect(result.malformedCount).toBe(1);
    expect(result.limit).toBe(20);
  });

  it("supports project, status, limit, and offset filters", () => {
    const rows: Session[] = [
      session("a1", "2026-08-01T00:00:00.000Z", { status: "active" }),
      session("a2", "2026-08-02T00:00:00.000Z", { status: "active" }),
      session("b1", "2026-08-03T00:00:00.000Z", {
        project: "project-b",
        status: "active",
      }),
      session("done", "2026-08-04T00:00:00.000Z"),
    ];

    const result = selectSessionsPage(rows, {
      project: "project-a",
      status: "active",
      limit: 1,
      offset: 1,
    });

    expect(result.sessions.map((s) => s.id)).toEqual(["a1"]);
    expect(result.total).toBe(2);
  });

  it("falls back to a valid timestamp when updatedAt is malformed", () => {
    const now = Date.parse("2026-08-08T08:00:00.000Z");
    const rows: Session[] = [
      session("fresh", "2026-08-08T07:30:00.000Z", {
        status: "active",
        updatedAt: "not-a-date",
      }),
    ];

    expect(
      findAbandonedSessions(rows, {
        now,
        thresholdMs: 4 * 60 * 60 * 1000,
      }),
    ).toEqual([]);
  });

  it("uses updatedAt rather than session age when detecting abandoned sessions", () => {
    const now = Date.parse("2026-08-08T08:00:00.000Z");
    const rows: Session[] = [
      session("recently-active", "2026-07-01T00:00:00.000Z", {
        status: "active",
        updatedAt: "2026-08-08T07:30:00.000Z",
      }),
      session("stale", "2026-08-07T00:00:00.000Z", {
        status: "active",
        updatedAt: "2026-08-08T00:00:00.000Z",
      }),
      session("completed", "2026-07-01T00:00:00.000Z", {
        status: "completed",
      }),
    ];

    const result = findAbandonedSessions(rows, {
      now,
      thresholdMs: 4 * 60 * 60 * 1000,
    });

    expect(result.map((s) => s.id)).toEqual(["stale"]);
  });
});
