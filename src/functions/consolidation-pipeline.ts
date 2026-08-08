import type { ISdk } from "iii-sdk";
import { createHash } from "node:crypto";
import type {
  SemanticMemory,
  ProceduralMemory,
  SessionSummary,
  Memory,
  MemoryProvider,
} from "../types.js";
import { KV, generateId, jaccardSimilarity } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  SEMANTIC_MERGE_SYSTEM,
  buildSemanticMergePrompt,
  PROCEDURAL_EXTRACTION_SYSTEM,
  buildProceduralExtractionPrompt,
} from "../prompts/consolidation.js";
import { recordAudit } from "./audit.js";
import { getConsolidationDecayDays, isConsolidationEnabled } from "../config.js";
import { logger } from "../logger.js";

interface ConsolidationFingerprintMarker {
  fingerprint: string;
  completedAt: string;
  project?: string;
  provider: string;
}

function normalizeProject(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function factKey(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function semanticTokens(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) || [],
  );
}

function tokenJaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function setIsSubset(left: Set<string>, right: Set<string>): boolean {
  for (const token of left) if (!right.has(token)) return false;
  return true;
}

function numericSignature(value: string): string {
  return (value.match(/\b(?:v(?:ersion)?\s*)?\d+(?:\.\d+)*\b/gi) || [])
    .map((item) => item.toLowerCase().replace(/\s+/g, ""))
    .sort()
    .join("|");
}

function negationSignature(value: string): string {
  const normalized = value.toLowerCase();
  return [
    /\bnot\b/,
    /\bno\b/,
    /\bnever\b/,
    /\bwithout\b/,
    /\bcannot\b/,
    /\bdon't\b/,
    /\bdoesn't\b/,
    /않/,
    /아니/,
    /없/,
    /금지/,
  ]
    .map((marker) => (marker.test(normalized) ? "1" : "0"))
    .join("");
}

function statusSignature(value: string): string {
  const normalized = value.toLowerCase();
  const markers = [
    "planned",
    "proposed",
    "pending",
    "currently",
    "implemented",
    "completed",
    "fixed",
    "removed",
    "deprecated",
    "enabled",
    "disabled",
    "failing",
    "passing",
    "draft",
    "released",
  ];
  return markers.filter((marker) => normalized.includes(marker)).sort().join("|");
}

function sourceOverlap(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const id of a) if (b.has(id)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function findSemanticCandidate(
  existing: SemanticMemory[],
  fact: string,
  sourceSessionIds: string[],
): SemanticMemory | undefined {
  const exact = existing.find((item) => factKey(item.fact) === factKey(fact));
  if (exact) return exact;

  const newTokens = semanticTokens(fact);
  const hasCjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u.test(
    fact,
  );
  return existing
    .map((item) => {
      if (numericSignature(item.fact) !== numericSignature(fact)) return null;
      if (negationSignature(item.fact) !== negationSignature(fact)) return null;
      if (statusSignature(item.fact) !== statusSignature(fact)) return null;
      const oldTokens = semanticTokens(item.fact);
      const lexical = tokenJaccard(oldTokens, newTokens);
      const similarity = hasCjk
        ? Math.max(lexical, jaccardSimilarity(item.fact, fact))
        : lexical;
      const provenance = sourceOverlap(item.sourceSessionIds, sourceSessionIds);
      const safeSubset =
        setIsSubset(oldTokens, newTokens) || setIsSubset(newTokens, oldTokens);
      const eligible =
        similarity >= 0.9 ||
        (provenance >= 0.5 && similarity >= 0.65 && safeSubset);
      return eligible ? { item, similarity, provenance } : null;
    })
    .filter(
      (candidate): candidate is {
        item: SemanticMemory;
        similarity: number;
        provenance: number;
      } => candidate !== null,
    )
    .sort(
      (a, b) =>
        b.similarity - a.similarity || b.provenance - a.provenance,
    )[0]?.item;
}

function semanticFingerprintKey(project: string | undefined): string {
  const scope = project || "__all__";
  const digest = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  return `consolidation:semantic:fingerprint:${digest}`;
}

function providerSignature(provider: MemoryProvider): string {
  const model =
    process.env["ANTHROPIC_MODEL"] ||
    process.env["GEMINI_MODEL"] ||
    process.env["OPENROUTER_MODEL"] ||
    process.env["OPENAI_MODEL"] ||
    process.env["MINIMAX_MODEL"] ||
    "default";
  return `${provider.name}:${model}`;
}

function buildSemanticFingerprint(
  provider: MemoryProvider,
  project: string | undefined,
  prompt: string,
  summaries: SessionSummary[],
): string {
  const sourceDescriptor = summaries.map((summary) => ({
    sessionId: summary.sessionId,
    createdAt: summary.createdAt,
    title: summary.title,
    narrative: summary.narrative,
    concepts: summary.concepts,
  }));
  return createHash("sha256")
    .update(SEMANTIC_MERGE_SYSTEM)
    .update("\0")
    .update(prompt)
    .update("\0")
    .update(JSON.stringify(sourceDescriptor))
    .update("\0")
    .update(providerSignature(provider))
    .update("\0")
    .update(project || "__all__")
    .digest("hex");
}

async function runSemanticConsolidation(
  kv: StateKV,
  provider: MemoryProvider,
  project: string | undefined,
): Promise<Record<string, unknown>> {
  const lockKey = `consolidation:semantic:${project || "__all__"}`;
  return withKeyedLock(lockKey, async () => {
    const summaries = await kv.list<SessionSummary>(KV.summaries);
    const existingSemantic = await kv.list<SemanticMemory>(KV.semantic);
    const scopedSummaries = project
      ? summaries.filter((summary) => summary.project === project)
      : summaries;
    const scopedSemantic = project
      ? existingSemantic.filter((item) => item.project === project)
      : existingSemantic;

    if (scopedSummaries.length < 5) {
      return { skipped: true, reason: "fewer than 5 summaries" };
    }

    const recentSummaries = scopedSummaries
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .slice(0, 20);
    const prompt = buildSemanticMergePrompt(
      recentSummaries.map((summary) => ({
        title: summary.title,
        narrative: summary.narrative,
        concepts: summary.concepts,
      })),
    );
    const fingerprint = buildSemanticFingerprint(
      provider,
      project,
      prompt,
      recentSummaries,
    );
    const markerKey = semanticFingerprintKey(project);
    const marker = await kv
      .get<ConsolidationFingerprintMarker>(KV.config, markerKey)
      .catch(() => null);
    if (marker?.fingerprint === fingerprint) {
      return {
        skipped: true,
        reason: "unchanged_input",
        inputFingerprint: fingerprint,
        totalSummaries: scopedSummaries.length,
      };
    }

    const response = await provider.summarize(SEMANTIC_MERGE_SYSTEM, prompt);
    const factRegex = /<fact\s+confidence="([^"]+)">([^<]+)<\/fact>/g;
    let match;
    let newFacts = 0;
    const now = new Date().toISOString();

    while ((match = factRegex.exec(response)) !== null) {
      const parsedConf = parseFloat(match[1]);
      const confidence = Number.isNaN(parsedConf) ? 0.5 : parsedConf;
      const fact = match[2].trim();
      const sourceSessionIds = recentSummaries.map((summary) => summary.sessionId);
      const existing = findSemanticCandidate(
        scopedSemantic,
        fact,
        sourceSessionIds,
      );
      if (existing) {
        existing.accessCount++;
        existing.lastAccessedAt = now;
        existing.updatedAt = now;
        existing.confidence = Math.max(existing.confidence, confidence);
        existing.strength = Math.max(existing.strength, confidence);
        existing.sourceSessionIds = [
          ...new Set([
            ...existing.sourceSessionIds,
            ...sourceSessionIds,
          ]),
        ];
        await kv.set(KV.semantic, existing.id, existing);
      } else {
        const semantic: SemanticMemory = {
          id: generateId("sem"),
          fact,
          confidence,
          sourceSessionIds,
          sourceMemoryIds: [],
          ...(project ? { project } : {}),
          accessCount: 1,
          lastAccessedAt: now,
          strength: confidence,
          createdAt: now,
          updatedAt: now,
        };
        await kv.set(KV.semantic, semantic.id, semantic);
        scopedSemantic.push(semantic);
        newFacts++;
      }
    }

    const completedAt = new Date().toISOString();
    await kv.set<ConsolidationFingerprintMarker>(KV.config, markerKey, {
      fingerprint,
      completedAt,
      ...(project ? { project } : {}),
      provider: providerSignature(provider),
    });
    return {
      newFacts,
      totalSummaries: scopedSummaries.length,
      inputFingerprint: fingerprint,
    };
  });
}

function applyDecay(
  items: Array<{
    strength: number;
    lastAccessedAt?: string;
    updatedAt: string;
  }>,
  decayDays: number,
): void {
  if (decayDays <= 0 || !Number.isFinite(decayDays)) return;
  const now = Date.now();
  for (const item of items) {
    const lastAccess = item.lastAccessedAt || item.updatedAt;
    const daysSince =
      (now - new Date(lastAccess).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > decayDays) {
      const decayPeriods = Math.floor(daysSince / decayDays);
      item.strength = Math.max(
        0.1,
        item.strength * Math.pow(0.9, decayPeriods),
      );
    }
  }
}

export function registerConsolidationPipelineFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::consolidate-pipeline", 
    async (data?: { tier?: string; force?: boolean; project?: string }) => {
      if (!data?.force && !isConsolidationEnabled()) {
        return { success: false, skipped: true, reason: "Consolidation disabled: set CONSOLIDATION_ENABLED=true or configure an LLM provider (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY / MINIMAX_API_KEY / OPENAI_BASE_URL / AGENTMEMORY_PROVIDER=agent-sdk)" };
      }
      const tier = data?.tier || "all";
      const project = normalizeProject(data?.project);
      const decayDays = getConsolidationDecayDays();
      const results: Record<string, unknown> = {};

      if (tier === "all" || tier === "semantic") {
        try {
          results.semantic = await runSemanticConsolidation(
            kv,
            provider,
            project,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("Semantic consolidation failed", { error: msg, project });
          results.semantic = { error: msg };
        }
      }

      if (tier === "all" || tier === "reflect") {
        try {
          const reflectResult = await sdk.trigger({ function_id: "mem::reflect", payload: {
            maxClusters: 10,
            project,
          } });
          results.reflect = reflectResult;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Reflect tier failed", { error: msg });
          results.reflect = { error: msg };
        }
      }

      if (tier === "all" || tier === "procedural") {
        const memories = await kv.list<Memory>(KV.memories);
        const patterns = memories
          .filter((m) => m.isLatest && m.type === "pattern")
          .filter((m) => !project || m.project === project)
          .map((m) => ({
            content: m.content,
            frequency: m.sessionIds.length || 1,
          }))
          .filter((p) => p.frequency >= 2);

        if (patterns.length >= 2) {
          const prompt = buildProceduralExtractionPrompt(patterns);

          try {
            const response = await provider.summarize(
              PROCEDURAL_EXTRACTION_SYSTEM,
              prompt,
            );

            const procRegex =
              /<procedure\s+name="([^"]+)"\s+trigger="([^"]+)">([\s\S]*?)<\/procedure>/g;
            let match;
            let newProcs = 0;
            const now = new Date().toISOString();
            const existingProcs = await kv.list<ProceduralMemory>(
              KV.procedural,
            );
            const scopedProcs = project
              ? existingProcs.filter((item) => item.project === project)
              : existingProcs;

            while ((match = procRegex.exec(response)) !== null) {
              const name = match[1];
              const trigger = match[2];
              const stepsBlock = match[3];
              const steps: string[] = [];

              const stepRegex = /<step>([^<]+)<\/step>/g;
              let stepMatch;
              while ((stepMatch = stepRegex.exec(stepsBlock)) !== null) {
                steps.push(stepMatch[1].trim());
              }

              const existing = scopedProcs.find(
                (p) => p.name.toLowerCase() === name.toLowerCase(),
              );
              if (existing) {
                existing.frequency++;
                existing.updatedAt = now;
                existing.strength = Math.min(1, existing.strength + 0.1);
                await kv.set(KV.procedural, existing.id, existing);
              } else {
                const proc: ProceduralMemory = {
                  id: generateId("proc"),
                  name,
                  steps,
                  triggerCondition: trigger,
                  frequency: 1,
                  sourceSessionIds: [],
                  ...(project ? { project } : {}),
                  strength: 0.5,
                  createdAt: now,
                  updatedAt: now,
                };
                await kv.set(KV.procedural, proc.id, proc);
                newProcs++;
              }
            }
            results.procedural = {
              newProcedures: newProcs,
              patternsAnalyzed: patterns.length,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error("Procedural extraction failed", { error: msg });
            results.procedural = { error: msg };
          }
        } else {
          results.procedural = {
            skipped: true,
            reason: "fewer than 2 recurring patterns",
          };
        }
      }

      if (tier === "all" || tier === "decay") {
        const semantic = await kv.list<SemanticMemory>(KV.semantic);
        const scopedSemantic = project
          ? semantic.filter((item) => item.project === project)
          : semantic;
        applyDecay(scopedSemantic, decayDays);
        for (const s of scopedSemantic) {
          await kv.set(KV.semantic, s.id, s);
        }

        const procedural = await kv.list<ProceduralMemory>(KV.procedural);
        const scopedProcedural = project
          ? procedural.filter((item) => item.project === project)
          : procedural;
        applyDecay(scopedProcedural, decayDays);
        for (const p of scopedProcedural) {
          await kv.set(KV.procedural, p.id, p);
        }

        results.decay = {
          semantic: scopedSemantic.length,
          procedural: scopedProcedural.length,
        };
      }

      if (process.env["OBSIDIAN_AUTO_EXPORT"] === "true") {
        try {
          await sdk.trigger({ function_id: "mem::obsidian-export", payload: {} });
          results.obsidianExport = { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("Obsidian auto-export failed", { error: msg });
          results.obsidianExport = { success: false, error: msg };
        }
      }

      await recordAudit(kv, "consolidate", "mem::consolidate-pipeline", [], {
        tier,
        project,
        results,
      });

      logger.info("Consolidation pipeline complete", { tier, project, results });
      return { success: true, results };
    },
  );
}
