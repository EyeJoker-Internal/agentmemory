import { describe, expect, it } from "vitest";
import { registerSemanticMergeFunction } from "../src/functions/semantic-merge.js";
import type { SemanticMemory } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> =>
      (Array.from(store.get(scope)?.values() ?? []) as T[]),
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => functions.set(id, handler),
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function semantic(
  id: string,
  fact: string,
  sourceSessionIds: string[],
  confidence: number,
): SemanticMemory {
  return {
    id,
    fact,
    confidence,
    sourceSessionIds,
    sourceMemoryIds: [`memory-${id}`],
    project: "portal",
    accessCount: 2,
    lastAccessedAt: "2026-08-08T00:00:00.000Z",
    strength: confidence,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

describe("mem::semantic-merge", () => {
  it("defaults to a dry run and leaves semantic rows unchanged", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerSemanticMergeFunction(sdk as never, kv as never);
    await kv.set(
      "mem:semantic",
      "sem_keep",
      semantic("sem_keep", "Portal uses SSO", ["s1"], 0.8),
    );
    await kv.set(
      "mem:semantic",
      "sem_drop",
      semantic("sem_drop", "SSO is used by Portal", ["s2"], 0.9),
    );

    const result = (await sdk.trigger("mem::semantic-merge", {
      groups: [{ keepId: "sem_keep", mergeIds: ["sem_drop"] }],
    })) as { success: boolean; dryRun: boolean; wouldDelete: number };

    expect(result).toMatchObject({ success: true, dryRun: true, wouldDelete: 1 });
    expect(await kv.list("mem:semantic")).toHaveLength(2);
    expect(await kv.list("mem:audit")).toHaveLength(0);
  });

  it("requires the exact confirmation phrase before applying", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerSemanticMergeFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::semantic-merge", {
      groups: [{ keepId: "sem_keep", mergeIds: ["sem_drop"] }],
      dryRun: false,
      confirm: "yes",
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("MERGE_SEMANTIC_DUPLICATES");
  });

  it("validates the whole plan before mutating any row", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerSemanticMergeFunction(sdk as never, kv as never);
    await kv.set(
      "mem:semantic",
      "sem_keep",
      semantic("sem_keep", "Portal uses SSO", ["s1"], 0.8),
    );

    const result = (await sdk.trigger("mem::semantic-merge", {
      groups: [{ keepId: "sem_keep", mergeIds: ["sem_missing"] }],
      dryRun: false,
      confirm: "MERGE_SEMANTIC_DUPLICATES",
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("sem_missing");
    expect(await kv.list("mem:semantic")).toHaveLength(1);
  });

  it("merges provenance and strength into the retained row before deletion", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerSemanticMergeFunction(sdk as never, kv as never);
    await kv.set(
      "mem:semantic",
      "sem_keep",
      semantic("sem_keep", "Portal uses SSO", ["s1"], 0.8),
    );
    await kv.set(
      "mem:semantic",
      "sem_drop_a",
      semantic("sem_drop_a", "SSO is used by Portal", ["s2"], 0.95),
    );
    await kv.set(
      "mem:semantic",
      "sem_drop_b",
      semantic("sem_drop_b", "Portal authentication uses SSO", ["s1", "s3"], 0.7),
    );

    const result = (await sdk.trigger("mem::semantic-merge", {
      groups: [
        {
          keepId: "sem_keep",
          mergeIds: ["sem_drop_a", "sem_drop_b"],
        },
      ],
      dryRun: false,
      confirm: "MERGE_SEMANTIC_DUPLICATES",
      reason: "audited conceptual duplicates",
    })) as { success: boolean; deleted: number; mergedGroups: number };

    expect(result).toMatchObject({ success: true, deleted: 2, mergedGroups: 1 });
    const rows = await kv.list<SemanticMemory>("mem:semantic");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "sem_keep",
      fact: "Portal uses SSO",
      confidence: 0.95,
      strength: 0.95,
      accessCount: 6,
    });
    expect(rows[0].sourceSessionIds.sort()).toEqual(["s1", "s2", "s3"]);
    expect(rows[0].sourceMemoryIds.sort()).toEqual([
      "memory-sem_drop_a",
      "memory-sem_drop_b",
      "memory-sem_keep",
    ]);
    const audits = await kv.list<{ functionId: string; targetIds: string[] }>(
      "mem:audit",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      functionId: "mem::semantic-merge",
      targetIds: ["sem_keep", "sem_drop_a", "sem_drop_b"],
    });
  });

  it("rejects an id that appears in multiple groups", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerSemanticMergeFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::semantic-merge", {
      groups: [
        { keepId: "sem_a", mergeIds: ["sem_b"] },
        { keepId: "sem_b", mergeIds: ["sem_c"] },
      ],
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("multiple groups");
  });
});
