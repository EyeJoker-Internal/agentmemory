import type { Session } from "../types.js";

export interface SessionPageOptions {
  agentId?: string;
  limit?: number;
  offset?: number;
  project?: string;
  status?: Session["status"];
}

export interface SessionPage {
  sessions: Session[];
  total: number;
  malformedCount: number;
  limit: number;
  offset: number;
}

export function sessionLastActivityMs(session: Session): number {
  for (const value of [session.updatedAt, session.endedAt, session.startedAt]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function selectSessionsPage(
  rows: Array<Session | Record<string, unknown>>,
  options: SessionPageOptions,
): SessionPage {
  const valid = rows.filter(
    (row): row is Session =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as { id?: unknown }).id === "string" &&
      Boolean((row as { id: string }).id.trim()),
  );
  const malformedCount = rows.length - valid.length;
  const filtered = valid
    .filter((session) => !options.agentId || session.agentId === options.agentId)
    .filter((session) => !options.project || session.project === options.project)
    .filter((session) => !options.status || session.status === options.status)
    .sort((a, b) => sessionLastActivityMs(b) - sessionLastActivityMs(a));
  const requestedLimit = Number(options.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 100)
    : 20;
  const requestedOffset = Number(options.offset);
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0
    ? requestedOffset
    : 0;

  return {
    sessions: filtered.slice(offset, offset + limit),
    total: filtered.length,
    malformedCount,
    limit,
    offset,
  };
}

export function findAbandonedSessions(
  rows: Array<Session | Record<string, unknown>>,
  options: { now?: number; thresholdMs: number },
): Session[] {
  const now = options.now ?? Date.now();
  return rows
    .filter(
      (row): row is Session =>
        typeof row === "object" &&
        row !== null &&
        typeof (row as { id?: unknown }).id === "string" &&
        Boolean((row as { id: string }).id.trim()),
    )
    .filter((session) => session.status === "active")
    .filter((session) => now - sessionLastActivityMs(session) > options.thresholdMs)
    .sort((a, b) => sessionLastActivityMs(a) - sessionLastActivityMs(b));
}
