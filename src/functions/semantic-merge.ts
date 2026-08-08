import type { ISdk } from "iii-sdk";
import type { SemanticMemory } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";

const CONFIRM_PHRASE = "MERGE_SEMANTIC_DUPLICATES";
const MAX_GROUPS = 100;
const MAX_MERGE_IDS = 50;

export interface SemanticMergeGroup {
  keepId: string;
  mergeIds: string[];
}

interface SemanticMergeRequest {
  groups?: SemanticMergeGroup[];
  dryRun?: boolean;
  confirm?: string;
  reason?: string;
}

function latestIso(values: string[]): string {
  return [...values].sort(
    (a, b) => new Date(b).getTime() - new Date(a).getTime(),
  )[0];
}

function validateGroups(
  groups: SemanticMergeGroup[] | undefined,
): { error: string } | { groups: SemanticMergeGroup[] } {
  if (!Array.isArray(groups) || groups.length === 0) {
    return { error: "groups must be a non-empty array" };
  }
  if (groups.length > MAX_GROUPS) {
    return { error: `groups cannot exceed ${MAX_GROUPS} per request` };
  }

  const claimedIds = new Set<string>();
  const normalized: SemanticMergeGroup[] = [];
  for (const [index, group] of groups.entries()) {
    const keepId = typeof group?.keepId === "string" ? group.keepId.trim() : "";
    const mergeIds = Array.isArray(group?.mergeIds)
      ? [
          ...new Set(
            group.mergeIds
              .filter((id): id is string => typeof id === "string")
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        ]
      : [];
    if (!keepId || mergeIds.length === 0) {
      return { error: `groups[${index}] requires keepId and mergeIds` };
    }
    if (mergeIds.length > MAX_MERGE_IDS) {
      return {
        error: `groups[${index}].mergeIds cannot exceed ${MAX_MERGE_IDS}`,
      };
    }
    if (mergeIds.includes(keepId)) {
      return { error: `groups[${index}] cannot merge keepId into itself` };
    }
    for (const id of [keepId, ...mergeIds]) {
      if (claimedIds.has(id)) {
        return { error: `${id} appears in multiple groups` };
      }
      claimedIds.add(id);
    }
    normalized.push({ keepId, mergeIds });
  }
  return { groups: normalized };
}

export function registerSemanticMergeFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::semantic-merge", async (data?: SemanticMergeRequest) => {
    const validated = validateGroups(data?.groups);
    if ("error" in validated) return { success: false, error: validated.error };

    const dryRun = data?.dryRun !== false;
    if (!dryRun && data?.confirm !== CONFIRM_PHRASE) {
      return {
        success: false,
        error: `confirm must equal ${CONFIRM_PHRASE}`,
      };
    }

    const rows = await kv.list<SemanticMemory>(KV.semantic);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const planned: Array<{
      group: SemanticMergeGroup;
      records: SemanticMemory[];
    }> = [];

    for (const group of validated.groups) {
      const ids = [group.keepId, ...group.mergeIds];
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        return {
          success: false,
          error: `semantic rows not found: ${missing.join(", ")}`,
        };
      }
      const records = ids.map((id) => byId.get(id)!);
      const projects = new Set(records.map((record) => record.project));
      if (projects.size > 1) {
        return {
          success: false,
          error: `semantic merge crosses project scopes: ${ids.join(", ")}`,
        };
      }
      planned.push({ group, records });
    }

    const wouldDelete = planned.reduce(
      (total, item) => total + item.group.mergeIds.length,
      0,
    );
    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        groups: planned.map(({ group, records }) => ({
          keepId: group.keepId,
          mergeIds: group.mergeIds,
          fact: records[0].fact,
          project: records[0].project,
          sourceSessionIds: [
            ...new Set(records.flatMap((row) => row.sourceSessionIds)),
          ],
        })),
        wouldDelete,
      };
    }

    const now = new Date().toISOString();
    const targetIds: string[] = [];
    for (const { group, records } of planned) {
      const keep = records[0];
      const merged: SemanticMemory = {
        ...keep,
        confidence: Math.max(...records.map((row) => row.confidence)),
        strength: Math.max(...records.map((row) => row.strength)),
        accessCount: records.reduce((sum, row) => sum + row.accessCount, 0),
        sourceSessionIds: [
          ...new Set(records.flatMap((row) => row.sourceSessionIds)),
        ],
        sourceMemoryIds: [
          ...new Set(records.flatMap((row) => row.sourceMemoryIds)),
        ],
        lastAccessedAt: latestIso(records.map((row) => row.lastAccessedAt)),
        updatedAt: now,
      };
      await kv.set(KV.semantic, keep.id, merged);
      for (const id of group.mergeIds) await kv.delete(KV.semantic, id);
      targetIds.push(group.keepId, ...group.mergeIds);
    }

    await recordAudit(kv, "consolidate", "mem::semantic-merge", targetIds, {
      reason: data?.reason || "audited conceptual duplicates",
      mergedGroups: planned.length,
      deleted: wouldDelete,
    });

    return {
      success: true,
      dryRun: false,
      mergedGroups: planned.length,
      deleted: wouldDelete,
    };
  });
}
