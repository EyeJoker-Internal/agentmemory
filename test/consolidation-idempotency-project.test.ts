import { describe, expect, it, vi } from "vitest";
import { registerConsolidationPipelineFunction } from "../src/functions/consolidation-pipeline.js";
import type { SemanticMemory, SessionSummary } from "../src/types.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  getConsolidationDecayDays: () => 30,
  isConsolidationEnabled: () => true,
}));

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

function summary(i: number, project: string, revision = "v1"): SessionSummary {
  return {
    sessionId: `${project}-${i}`,
    project,
    createdAt: new Date(Date.UTC(2026, 7, 8, 0, i)).toISOString(),
    title: `${project} summary ${i}`,
    narrative: `${project} narrative ${i} ${revision}`,
    keyDecisions: [],
    filesModified: [],
    concepts: [project],
    observationCount: 1,
  };
}

async function seedProject(
  kv: ReturnType<typeof mockKV>,
  project: string,
  revision = "v1",
): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const item = summary(i, project, revision);
    await kv.set("mem:summaries", item.sessionId, item);
  }
}

describe("semantic consolidation idempotency and project scope", () => {
  it("skips an unchanged prompt fingerprint even when force is true", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test-model",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        '<facts><fact confidence="0.9">Portal uses SSO</fact></facts>',
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedProject(kv, "portal");

    const first = await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
      force: true,
    });
    const second = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
      force: true,
    })) as { results: { semantic: { skipped?: boolean; reason?: string } } };

    expect(first).toBeDefined();
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(second.results.semantic).toMatchObject({
      skipped: true,
      reason: "unchanged_input",
    });
  });

  it("serializes concurrent identical consolidation calls", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = {
      name: "test-model",
      compress: vi.fn(),
      summarize: vi.fn(async () => {
        await gate;
        return '<facts><fact confidence="0.9">Portal uses SSO</fact></facts>';
      }),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedProject(kv, "portal");

    const first = sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
    });
    const second = sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
    });
    await Promise.resolve();
    release();
    await Promise.all([first, second]);

    expect(provider.summarize).toHaveBeenCalledTimes(1);
  });

  it("runs again when the scoped summary input changes", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test-model",
      compress: vi.fn(),
      summarize: vi.fn().mockResolvedValue(
        '<facts><fact confidence="0.9">Portal uses SSO</fact></facts>',
      ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedProject(kv, "portal");
    await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
    });

    const changed = summary(4, "portal", "v2");
    changed.createdAt = "2026-08-09T00:00:00.000Z";
    await kv.set("mem:summaries", changed.sessionId, changed);
    await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
    });

    expect(provider.summarize).toHaveBeenCalledTimes(2);
  });

  it("isolates summary inputs and stored semantic facts by project", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test-model",
      compress: vi.fn(),
      summarize: vi
        .fn()
        .mockResolvedValueOnce(
          '<facts><fact confidence="0.9">Portal uses SSO</fact></facts>',
        )
        .mockResolvedValueOnce(
          '<facts><fact confidence="0.8">soriQ uses AutoEQ</fact></facts>',
        ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedProject(kv, "portal");
    await seedProject(kv, "soriq");

    await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
    });
    await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "soriq",
    });

    const semantic = await kv.list<SemanticMemory>("mem:semantic");
    expect(semantic).toHaveLength(2);
    expect(semantic.map((item) => [item.fact, item.project])).toEqual([
      ["Portal uses SSO", "portal"],
      ["soriQ uses AutoEQ", "soriq"],
    ]);
    const prompts = provider.summarize.mock.calls.map((call) => call[1] as string);
    expect(prompts[0]).toContain("portal narrative");
    expect(prompts[0]).not.toContain("soriq narrative");
    expect(prompts[1]).toContain("soriq narrative");
    expect(prompts[1]).not.toContain("portal narrative");
  });
  it("treats a changed source-session set as new input and reinforces provenance", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test-model",
      compress: vi.fn(),
      summarize: vi
        .fn()
        .mockResolvedValueOnce(
          '<facts><fact confidence="0.9">Portal uses SSO</fact></facts>',
        )
        .mockResolvedValueOnce(
          '<facts><fact confidence="0.95">Portal authentication uses SSO</fact></facts>',
        ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedProject(kv, "portal");
    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic", project: "portal" });

    const replacement = summary(4, "portal");
    replacement.sessionId = "portal-replacement";
    await kv.delete("mem:summaries", "portal-4");
    await kv.set("mem:summaries", replacement.sessionId, replacement);
    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic", project: "portal" });

    expect(provider.summarize).toHaveBeenCalledTimes(2);
    const rows = await kv.list<SemanticMemory>("mem:semantic");
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceSessionIds).toContain("portal-4");
    expect(rows[0].sourceSessionIds).toContain("portal-replacement");
    expect(rows[0].accessCount).toBe(2);
  });

  it("keeps changed numeric and lifecycle states as separate facts", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test-model",
      compress: vi.fn(),
      summarize: vi
        .fn()
        .mockResolvedValueOnce(
          '<facts><fact confidence="0.9">Portal API uses version 1</fact></facts>',
        )
        .mockResolvedValueOnce(
          '<facts><fact confidence="0.9">Portal API uses version 2</fact></facts>',
        )
        .mockResolvedValueOnce(
          '<facts><fact confidence="0.9">Portal API version 2 is implemented</fact></facts>',
        ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedProject(kv, "portal");
    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic", project: "portal" });

    const replacementOne = summary(4, "portal");
    replacementOne.sessionId = "portal-state-1";
    await kv.delete("mem:summaries", "portal-4");
    await kv.set("mem:summaries", replacementOne.sessionId, replacementOne);
    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic", project: "portal" });

    const replacementTwo = summary(4, "portal");
    replacementTwo.sessionId = "portal-state-2";
    await kv.delete("mem:summaries", "portal-state-1");
    await kv.set("mem:summaries", replacementTwo.sessionId, replacementTwo);
    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic", project: "portal" });

    const rows = await kv.list<SemanticMemory>("mem:semantic");
    expect(rows.map((row) => row.fact).sort()).toEqual([
      "Portal API uses version 1",
      "Portal API uses version 2",
      "Portal API version 2 is implemented",
    ]);
  });

});
