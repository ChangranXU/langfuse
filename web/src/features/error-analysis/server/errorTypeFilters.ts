import type { PrismaClient } from "@prisma/client";
import type { FilterState } from "@langfuse/shared";

function isErrorTypeColumn(column: unknown): boolean {
  const c = String(column ?? "")
    .trim()
    .toLowerCase();
  return c === "errortype" || c === "error type";
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
}

function parseErrorTypeFilter(filter: any): {
  mode: "include" | "exclude" | "unsupported";
  values: string[];
} {
  if (!filter || !isErrorTypeColumn(filter.column)) {
    return { mode: "unsupported", values: [] };
  }

  const type = String(filter.type ?? "").toLowerCase();
  const operator = String(filter.operator ?? "").toLowerCase();

  // Checkbox-based facet selections
  if (type === "stringoptions" && operator === "any of") {
    return { mode: "include", values: normalizeStringList(filter.value) };
  }
  if (type === "stringoptions" && operator === "none of") {
    return { mode: "exclude", values: normalizeStringList(filter.value) };
  }

  // Freeform filter builder usage
  if (type === "string" && operator === "=") {
    const v = filter.value != null ? String(filter.value).trim() : "";
    return { mode: "include", values: v ? [v] : [] };
  }

  // Unsupported operators/types: strip to avoid breaking ClickHouse mappings.
  return { mode: "unsupported", values: [] };
}

export async function applyErrorTypeFilters(params: {
  prisma: PrismaClient;
  projectId: string;
  filterState: FilterState;
}): Promise<{ filterState: FilterState; hasNoMatches: boolean }> {
  const selectedTypes = new Set<string>();
  const excludedTypes = new Set<string>();
  let sawErrorTypeFilter = false;
  const remaining: FilterState = [];

  for (const f of params.filterState ?? []) {
    if (!isErrorTypeColumn((f as any)?.column)) {
      remaining.push(f);
      continue;
    }

    sawErrorTypeFilter = true;
    const parsed = parseErrorTypeFilter(f);
    if (parsed.mode === "include") {
      parsed.values.forEach((v) => selectedTypes.add(v));
    } else if (parsed.mode === "exclude") {
      parsed.values.forEach((v) => excludedTypes.add(v));
    }
    // Always strip errorType filters here. We'll translate them into an ID filter below.
  }

  if (!sawErrorTypeFilter) {
    return { filterState: params.filterState, hasNoMatches: false };
  }

  // If the filter was present but had no concrete values (or unsupported operator),
  // treat it as a no-op and keep the rest of the filters.
  if (selectedTypes.size === 0 && excludedTypes.size === 0) {
    return { filterState: remaining, hasNoMatches: false };
  }

  let matches: Array<{ observationId: string }> = [];
  try {
    const delegate = (params.prisma as any).errorAnalysis as any;
    // Prefer explicit include selection.
    if (selectedTypes.size > 0) {
      matches = (await delegate.findMany({
        where: {
          projectId: params.projectId,
          errorType: { in: [...selectedTypes] },
        },
        select: { observationId: true },
      })) as Array<{ observationId: string }>;
    } else {
      // Exclude selection: interpret as "show observations with an explicit errorType
      // that is NOT in the excluded list".
      matches = (await delegate.findMany({
        where: {
          projectId: params.projectId,
          errorType: {
            not: null,
            ...(excludedTypes.size > 0 ? { notIn: [...excludedTypes] } : {}),
          },
        },
        select: { observationId: true },
      })) as Array<{ observationId: string }>;
    }
  } catch {
    // If the DB/client doesn't support errorType yet, don't block the query.
    // But do strip the filter to avoid breaking ClickHouse table mappings.
    return { filterState: remaining, hasNoMatches: false };
  }

  const observationIds = matches.map((m) => m.observationId);
  if (observationIds.length === 0) {
    return { filterState: remaining, hasNoMatches: true };
  }

  const next: FilterState = [
    ...remaining,
    {
      column: "id",
      type: "stringOptions",
      operator: "any of",
      value: observationIds,
    } as any,
  ];

  return { filterState: next, hasNoMatches: false };
}

export async function getErrorTypeFilterOptions(params: {
  prisma: PrismaClient;
  projectId: string;
}): Promise<Array<{ value: string; count: number }>> {
  let grouped: Array<any> = [];
  try {
    const delegate = (params.prisma as any).errorAnalysis as any;
    grouped = (await delegate.groupBy({
      by: ["errorType"],
      where: {
        projectId: params.projectId,
        errorType: { not: null },
      },
      _count: {
        errorType: true,
      },
    })) as Array<any>;
  } catch {
    // If the DB/client doesn't support errorType yet, omit facet options.
    return [];
  }

  return grouped
    .filter((g) => g?.errorType)
    .map((g) => ({
      value: String(g.errorType),
      count: Number(g?._count?.errorType ?? g?._count?._all ?? 0),
    }))
    .sort((a, b) => b.count - a.count);
}
