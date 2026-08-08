import { TriggerAction, type ISdk } from "iii-sdk";
import type { Session } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { findAbandonedSessions } from "./session-maintenance.js";

interface ReapOptions {
  dryRun?: boolean;
  limit?: number;
  now?: string;
  thresholdHours?: number;
}

export function registerSessionReapFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::session-reap", async (options?: ReapOptions) => {
    const thresholdHours =
      Number.isFinite(options?.thresholdHours) && Number(options?.thresholdHours) > 0
        ? Math.min(Number(options?.thresholdHours), 24 * 30)
        : 24;
    const requestedLimit = Number(options?.limit);
    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 50)
        : 10;
    const parsedNow = options?.now ? Date.parse(options.now) : Date.now();
    if (!Number.isFinite(parsedNow)) {
      return { success: false, error: "now must be a valid ISO timestamp" };
    }

    const rows = await kv.list<Session | Record<string, unknown>>(KV.sessions);
    const stale = findAbandonedSessions(rows, {
      now: parsedNow,
      thresholdMs: thresholdHours * 60 * 60 * 1000,
    });
    const candidates = stale.slice(0, limit);
    if (options?.dryRun) {
      return {
        success: true,
        dryRun: true,
        candidateCount: stale.length,
        candidates: candidates.map((session) => session.id),
        reaped: [],
      };
    }

    const endedAt = new Date(parsedNow).toISOString();
    const reaped: string[] = [];
    for (const session of candidates) {
      await kv.update(KV.sessions, session.id, [
        { type: "set", path: "updatedAt", value: endedAt },
        { type: "set", path: "endedAt", value: endedAt },
        { type: "set", path: "status", value: "abandoned" },
      ]);
      sdk
        .trigger({
          function_id: "event::session::stopped",
          payload: { sessionId: session.id, skipConsolidation: true },
          action: TriggerAction.Void(),
        })
        .catch(() => {});
      reaped.push(session.id);
    }

    return {
      success: true,
      dryRun: false,
      candidateCount: stale.length,
      candidates: candidates.map((session) => session.id),
      reaped,
    };
  });
}
