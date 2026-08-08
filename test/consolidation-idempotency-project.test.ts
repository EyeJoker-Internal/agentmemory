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
      flushPending: true,
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
          '<facts><fact confidence="0.95">Portal uses SSO</fact></facts>',
        ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedProject(kv, "portal");
    await sdk.trigger("mem::consolidate-pipeline", { tier: "semantic", project: "portal" });

    const replacement = summary(4, "portal");
    replacement.sessionId = "portal-replacement";
    await kv.delete("mem:summaries", "portal-4");
    await kv.set("mem:summaries", replacement.sessionId, replacement);
    await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
      flushPending: true,
    });

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
    await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
      flushPending: true,
    });

    const replacementTwo = summary(4, "portal");
    replacementTwo.sessionId = "portal-state-2";
    await kv.delete("mem:summaries", "portal-state-1");
    await kv.set("mem:summaries", replacementTwo.sessionId, replacementTwo);
    await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
      flushPending: true,
    });

    const rows = await kv.list<SemanticMemory>("mem:semantic");
    expect(rows.map((row) => row.fact).sort()).toEqual([
      "Portal API uses version 1",
      "Portal API uses version 2",
      "Portal API version 2 is implemented",
    ]);
  });


  it("processes only unprocessed summaries after five new summaries accumulate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T01:00:00.000Z");
    try {
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
      for (let i = 5; i < 9; i++) {
        const item = summary(i, "portal");
        await kv.set("mem:summaries", item.sessionId, item);
      }

      const waiting = (await sdk.trigger("mem::consolidate-pipeline", {
        tier: "semantic",
        project: "portal",
      })) as { results: { semantic: { reason: string; pendingSummaries: number } } };
      expect(waiting.results.semantic).toMatchObject({
        reason: "waiting_for_delta_batch",
        pendingSummaries: 4,
      });
      expect(provider.summarize).toHaveBeenCalledTimes(1);

      const fifth = summary(9, "portal");
      await kv.set("mem:summaries", fifth.sessionId, fifth);
      const processed = (await sdk.trigger("mem::consolidate-pipeline", {
        tier: "semantic",
        project: "portal",
      })) as { results: { semantic: { processedSummaries: number } } };

      expect(processed.results.semantic.processedSummaries).toBe(5);
      expect(provider.summarize).toHaveBeenCalledTimes(2);
      const secondPrompt = provider.summarize.mock.calls[1][1] as string;
      expect(secondPrompt).toContain("portal narrative 5");
      expect(secondPrompt).toContain("portal narrative 9");
      expect(secondPrompt).not.toContain("portal narrative 0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a partial delta batch after twenty-four hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T01:00:00.000Z");
    try {
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

      const pending = summary(5, "portal");
      await kv.set("mem:summaries", pending.sessionId, pending);
      const waiting = (await sdk.trigger("mem::consolidate-pipeline", {
        tier: "semantic",
        project: "portal",
      })) as { results: { semantic: { reason: string } } };
      expect(waiting.results.semantic.reason).toBe("waiting_for_delta_batch");

      vi.setSystemTime("2026-08-09T01:06:00.000Z");
      const flushed = (await sdk.trigger("mem::consolidate-pipeline", {
        tier: "semantic",
        project: "portal",
      })) as { results: { semantic: { processedSummaries: number } } };
      expect(flushed.results.semantic.processedSummaries).toBe(1);
      expect(provider.summarize).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not advance the delta watermark when the provider fails", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test-model",
      compress: vi.fn(),
      summarize: vi
        .fn()
        .mockRejectedValueOnce(new Error("provider unavailable"))
        .mockResolvedValueOnce(
          '<facts><fact confidence="0.9">Portal uses SSO</fact></facts>',
        ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedProject(kv, "portal");

    const failed = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
    })) as { results: { semantic: { error?: string } } };
    expect(failed.results.semantic.error).toContain("provider unavailable");

    const retried = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
    })) as { results: { semantic: { processedSummaries: number } } };
    expect(retried.results.semantic.processedSummaries).toBe(5);
    expect(provider.summarize).toHaveBeenCalledTimes(2);
  });

  it("bootstraps delta watermarks without replaying an existing semantic corpus", async () => {
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
    await kv.set("mem:semantic", "legacy", {
      id: "legacy",
      fact: "Existing legacy fact",
      confidence: 0.9,
      sourceSessionIds: [],
      sourceMemoryIds: [],
      accessCount: 0,
      lastAccessedAt: "2026-08-08T00:00:00.000Z",
      strength: 1,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    } satisfies SemanticMemory);

    const initialized = (await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
    })) as { results: { semantic: { reason: string; processedSummaries: number } } };
    expect(initialized.results.semantic).toMatchObject({
      reason: "delta_watermark_initialized",
      processedSummaries: 5,
    });
    expect(provider.summarize).not.toHaveBeenCalled();

    for (let i = 5; i < 10; i++) {
      const item = summary(i, "portal");
      await kv.set("mem:summaries", item.sessionId, item);
    }
    await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
    });
    expect(provider.summarize).toHaveBeenCalledTimes(1);
    const prompt = provider.summarize.mock.calls[0][1] as string;
    expect(prompt).toContain("portal narrative 5");
    expect(prompt).not.toContain("portal narrative 0");
  });

  it("reports per-project semantic delta watermark status", async () => {
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

    const status = (await sdk.trigger("mem::semantic-status", {})) as {
      success: boolean;
      projects: Array<{
        project: string;
        totalSummaries: number;
        processedSummaries: number;
        pendingSummaries: number;
      }>;
    };
    expect(status.success).toBe(true);
    expect(status.projects).toContainEqual({
      project: "portal",
      totalSummaries: 5,
      processedSummaries: 5,
      pendingSummaries: 0,
      pendingSince: undefined,
    });
  });


  it("keeps a general principle separate from a project-specific application without shared provenance", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test-model",
      compress: vi.fn(),
      summarize: vi
        .fn()
        .mockResolvedValueOnce(
          '<facts><fact confidence="0.9">Code reviews require source verification</fact></facts>',
        )
        .mockResolvedValueOnce(
          '<facts><fact confidence="0.9">Portal code reviews require source verification</fact></facts>',
        ),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedProject(kv, "portal");
    await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
    });

    const replacement = summary(4, "portal");
    replacement.sessionId = "portal-specific-application";
    await kv.delete("mem:summaries", "portal-4");
    await kv.set("mem:summaries", replacement.sessionId, replacement);
    await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
      flushPending: true,
    });

    const rows = await kv.list<SemanticMemory>("mem:semantic");
    expect(rows.map((row) => row.fact).sort()).toEqual([
      "Code reviews require source verification",
      "Portal code reviews require source verification",
    ]);
  });


  it("persists delta watermarks across function registration restarts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-08T01:00:00.000Z");
    try {
      const kv = mockKV();
      const firstSdk = mockSdk();
      const firstProvider = {
        name: "test-model",
        compress: vi.fn(),
        summarize: vi.fn().mockResolvedValue(
          '<facts><fact confidence="0.9">Portal uses SSO</fact></facts>',
        ),
      };
      registerConsolidationPipelineFunction(
        firstSdk as never,
        kv as never,
        firstProvider as never,
      );
      await seedProject(kv, "portal");
      await firstSdk.trigger("mem::consolidate-pipeline", {
        tier: "semantic",
        project: "portal",
      });

      for (let i = 5; i < 9; i++) {
        const item = summary(i, "portal");
        await kv.set("mem:summaries", item.sessionId, item);
      }
      const secondSdk = mockSdk();
      const secondProvider = {
        name: "test-model",
        compress: vi.fn(),
        summarize: vi.fn().mockResolvedValue(
          '<facts><fact confidence="0.9">Portal uses SSO</fact></facts>',
        ),
      };
      registerConsolidationPipelineFunction(
        secondSdk as never,
        kv as never,
        secondProvider as never,
      );
      const waiting = (await secondSdk.trigger("mem::consolidate-pipeline", {
        tier: "semantic",
        project: "portal",
      })) as { results: { semantic: { reason: string; pendingSummaries: number } } };
      expect(waiting.results.semantic).toMatchObject({
        reason: "waiting_for_delta_batch",
        pendingSummaries: 4,
      });
      expect(secondProvider.summarize).not.toHaveBeenCalled();

      const fifth = summary(9, "portal");
      await kv.set("mem:summaries", fifth.sessionId, fifth);
      await secondSdk.trigger("mem::consolidate-pipeline", {
        tier: "semantic",
        project: "portal",
      });
      expect(secondProvider.summarize).toHaveBeenCalledTimes(1);
      const prompt = secondProvider.summarize.mock.calls[0][1] as string;
      expect(prompt).toContain("portal narrative 5");
      expect(prompt).not.toContain("portal narrative 0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bootstraps every existing project in one migration pass", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const provider = {
      name: "test-model",
      compress: vi.fn(),
      summarize: vi.fn(),
    };
    registerConsolidationPipelineFunction(sdk as never, kv as never, provider as never);
    await seedProject(kv, "portal");
    await seedProject(kv, "soriq");
    await kv.set("mem:semantic", "legacy", {
      id: "legacy",
      fact: "Existing legacy fact",
      confidence: 0.9,
      sourceSessionIds: [],
      sourceMemoryIds: [],
      accessCount: 0,
      lastAccessedAt: "2026-08-08T00:00:00.000Z",
      strength: 1,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    } satisfies SemanticMemory);

    await sdk.trigger("mem::consolidate-pipeline", {
      tier: "semantic",
      project: "portal",
    });
    const status = (await sdk.trigger("mem::semantic-status", {})) as {
      projects: Array<{
        project: string;
        totalSummaries: number;
        processedSummaries: number;
        pendingSummaries: number;
      }>;
    };
    expect(status.projects).toEqual([
      {
        project: "portal",
        totalSummaries: 5,
        processedSummaries: 5,
        pendingSummaries: 0,
        pendingSince: undefined,
      },
      {
        project: "soriq",
        totalSummaries: 5,
        processedSummaries: 5,
        pendingSummaries: 0,
        pendingSince: undefined,
      },
    ]);
    expect(provider.summarize).not.toHaveBeenCalled();
  });

});
