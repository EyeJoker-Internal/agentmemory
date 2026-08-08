import type { SemanticMemory } from "../types.js";

export interface SemanticRankingOptions {
  project?: string;
  includeLegacy?: boolean;
}

export interface SemanticRankingResult {
  rows: SemanticMemory[];
  scoped: number;
  legacy: number;
  excludedOtherProjects: number;
}

function rankByQuality(left: SemanticMemory, right: SemanticMemory): number {
  return (
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() ||
    right.strength - left.strength ||
    right.confidence - left.confidence ||
    left.id.localeCompare(right.id)
  );
}

export function rankSemanticForProject(
  rows: SemanticMemory[],
  options: SemanticRankingOptions,
): SemanticRankingResult {
  const project = options.project?.trim();
  if (!project) {
    return {
      rows: [...rows],
      scoped: rows.filter((row) => Boolean(row.project)).length,
      legacy: rows.filter((row) => !row.project).length,
      excludedOtherProjects: 0,
    };
  }

  const scoped = rows
    .filter((row) => row.project === project)
    .sort(rankByQuality);
  const legacy = options.includeLegacy === false
    ? []
    : rows.filter((row) => !row.project).sort(rankByQuality);
  const excludedOtherProjects = rows.filter(
    (row) => row.project && row.project !== project,
  ).length;

  return {
    rows: [...scoped, ...legacy],
    scoped: scoped.length,
    legacy: legacy.length,
    excludedOtherProjects,
  };
}
