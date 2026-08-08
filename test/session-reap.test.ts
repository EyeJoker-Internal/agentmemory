import { describe, expect, it, vi } from "vitest";
import { registerSessionReapFunction } from "../src/functions/session-reap.js";
import type { Session } from "../src/types.js";

function createHarness(rows: Session[]) {
  const functions = new Map<string, Function>();
  const updates: Array<{ scope: string; key: string; ops: unknown[] }> = [];
  const triggers: Array<{ function_id: string; payload: unknown }> = [];
  const sdk = {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    trigger: vi.fn(async (request: { function_id: string; payload: unknown }) => {
      triggers.push(request);
      return {};
    }),
  };
  const kv = {
    list: vi.fn(async () => rows),
    update: vi.fn(async (scope: string, key: string, ops: unknown[]) => {
      updates.push({ scope, key, ops });
      return {};
    }),
  };
  registerSessionReapFunction(sdk as any, kv as any);
  return {
    handler: functions.get("mem::session-reap")!,
    updates,
    triggers,
  };
}

function active(id: string, startedAt: string, updatedAt?: string): Session {
  return {
    id,
    project: "project",
    cwd: "/tmp",
    startedAt,
    updatedAt,
    status: "active",
    observationCount: 1,
  };
}

describe("mem::session-reap", () => {
  it("ends only sessions whose last activity exceeds the threshold", async () => {
    const { handler, updates, triggers } = createHarness([
      active("fresh", "2026-07-01T00:00:00.000Z", "2026-08-08T07:30:00.000Z"),
      active("stale", "2026-08-07T00:00:00.000Z", "2026-08-08T00:00:00.000Z"),
    ]);

    const result: any = await handler({
      now: "2026-08-08T08:00:00.000Z",
      thresholdHours: 4,
    });

    expect(result.reaped).toEqual(["stale"]);
    expect(updates.map((entry) => entry.key)).toEqual(["stale"]);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      function_id: "event::session::stopped",
      payload: { sessionId: "stale", skipConsolidation: true, skipGraph: true },
    });
  });

  it("supports dry-run without state changes", async () => {
    const { handler, updates, triggers } = createHarness([
      active("stale", "2026-08-07T00:00:00.000Z"),
    ]);

    const result: any = await handler({
      now: "2026-08-08T08:00:00.000Z",
      thresholdHours: 4,
      dryRun: true,
    });

    expect(result.candidates).toEqual(["stale"]);
    expect(result.reaped).toEqual([]);
    expect(updates).toHaveLength(0);
    expect(triggers).toHaveLength(0);
  });
});
