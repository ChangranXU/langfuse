import { useEffect, useMemo, useState } from "react";
import { api, directApi } from "@/src/utils/api";
import { useIsAuthenticatedAndProjectMember } from "@/src/features/auth/hooks";
import { useTraceData } from "@/src/components/trace2/contexts/TraceDataContext";
import { useSelection } from "@/src/components/trace2/contexts/SelectionContext";

const GOVERNANCE_REFRESH_INTERVAL_MS = 5_000;

function getMetadataRecord(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }

  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // no-op
    }
  }

  return {};
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && !!item.trim(),
    );
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === "string" && !!item.trim(),
        );
      }
    } catch {
      // no-op
    }
    if (value.includes(",")) {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function parseStringRecord(value: unknown): Record<string, string> {
  let input = value;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return {};
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const entries = Object.entries(input as Record<string, unknown>).flatMap(
    ([key, val]) =>
      typeof val === "string" && val.trim().length > 0
        ? [[key, val] as const]
        : [],
  );
  return Object.fromEntries(entries);
}

function derivePolicyNamesFromMetadata(metadata: unknown): string[] {
  const record = getMetadataRecord(metadata);
  const policyNames = new Set<string>(parseStringArray(record.policy_names));
  parseStringArray(record.policy_name).forEach((name) => policyNames.add(name));
  Object.keys(parseStringRecord(record.policy_descriptions)).forEach((name) =>
    policyNames.add(name),
  );
  Object.keys(parseStringRecord(record.policy_sources)).forEach((name) =>
    policyNames.add(name),
  );

  if (policyNames.size > 0) {
    return Array.from(policyNames);
  }
  return [];
}

function getPolicyViolationFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  return false;
}

function isPolicyCheckNode(record: Record<string, unknown>): boolean {
  const parserStage =
    typeof record.parser_stage === "string"
      ? record.parser_stage.trim()
      : typeof record.parserStage === "string"
        ? record.parserStage.trim()
        : "";
  const nodeType =
    typeof record.node_type === "string"
      ? record.node_type
      : typeof record.nodeType === "string"
        ? record.nodeType
        : "";
  return parserStage.startsWith("pre_") || nodeType === "output";
}

function isPolicyViolationObservation(params: {
  level: string | null | undefined;
  metadata: unknown;
}): boolean {
  const metadataRecord = getMetadataRecord(params.metadata);
  const hasViolationSignal =
    params.level === "POLICY_VIOLATION" ||
    getPolicyViolationFlag(metadataRecord.policy_violation);
  if (!hasViolationSignal) return false;
  return isPolicyCheckNode(metadataRecord);
}

export function TraceGovernanceBanner() {
  const { trace, observations } = useTraceData();
  const { selectedNodeId, setSelectedNodeId } = useSelection();
  const hasProjectAccess = useIsAuthenticatedAndProjectMember(trace.projectId);
  const [errorTypeByObservationId, setErrorTypeByObservationId] = useState<
    Record<string, string | null>
  >({});
  const [isErrorTypeLoading, setIsErrorTypeLoading] = useState(false);
  const [expandedErrorType, setExpandedErrorType] = useState<string | null>(
    null,
  );
  const [expandedPolicyViolationType, setExpandedPolicyViolationType] =
    useState<string | null>(null);
  const [policyNamesByObservationId, setPolicyNamesByObservationId] = useState<
    Record<string, string[]>
  >({});
  const [isPolicyTypeLoading, setIsPolicyTypeLoading] = useState(false);

  const errorAnalysisSettingsQuery =
    api.projects.getErrorAnalysisSettings.useQuery(
      { projectId: trace.projectId },
      {
        enabled: hasProjectAccess,
        refetchOnWindowFocus: false,
        retry: false,
      },
    );

  const policyViolationObservations = useMemo(() => {
    const strict = observations.filter((obs) =>
      isPolicyViolationObservation({
        level: obs.level,
        metadata: obs.metadata,
      }),
    );
    if (strict.length > 0) return strict;
    return observations.filter((obs) => obs.level === "POLICY_VIOLATION");
  }, [observations]);

  const {
    errorCount,
    warningCount,
    policyViolationCount,
    errorObservationIds,
  } = useMemo(() => {
    const errorObservations = observations.filter(
      (obs) => obs.level === "ERROR",
    );
    const errorCount = errorObservations.length;
    const warningCount = observations.filter(
      (obs) => obs.level === "WARNING",
    ).length;
    const policyViolationCount = policyViolationObservations.length;

    return {
      errorCount,
      warningCount,
      policyViolationCount,
      errorObservationIds: errorObservations.map((obs) => obs.id),
    };
  }, [observations, policyViolationObservations]);

  useEffect(() => {
    if (!hasProjectAccess || errorObservationIds.length === 0) {
      setErrorTypeByObservationId({});
      setIsErrorTypeLoading(false);
      return;
    }

    let cancelled = false;
    const fetchErrorTypes = async (isInitialFetch: boolean) => {
      if (isInitialFetch) {
        setIsErrorTypeLoading(true);
      }

      const results = await Promise.all(
        errorObservationIds.map(async (observationId) => {
          try {
            const result = await directApi.errorAnalysis.getSummary.query({
              projectId: trace.projectId,
              traceId: trace.id,
              observationId,
            });

            return {
              observationId,
              errorType: result?.errorType ?? null,
            };
          } catch {
            return {
              observationId,
              errorType: null,
            };
          }
        }),
      );

      if (cancelled) return;

      setErrorTypeByObservationId(
        Object.fromEntries(
          results.map((item) => [item.observationId, item.errorType]),
        ),
      );
      if (isInitialFetch) {
        setIsErrorTypeLoading(false);
      }
    };

    void fetchErrorTypes(true);
    const intervalId = window.setInterval(() => {
      void fetchErrorTypes(false);
    }, GOVERNANCE_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [hasProjectAccess, errorObservationIds, trace.projectId, trace.id]);

  useEffect(() => {
    if (!hasProjectAccess || policyViolationObservations.length === 0) {
      setPolicyNamesByObservationId({});
      setIsPolicyTypeLoading(false);
      return;
    }

    let cancelled = false;
    const fetchPolicyNames = async () => {
      setIsPolicyTypeLoading(true);
      const results = await Promise.all(
        policyViolationObservations.map(async (obs) => {
          try {
            const result = await directApi.observations.byId.query({
              projectId: trace.projectId,
              traceId: trace.id,
              observationId: obs.id,
              startTime: obs.startTime,
              verbosity: "compact",
            });
            return {
              observationId: obs.id,
              policyNames: derivePolicyNamesFromMetadata(result.metadata),
            };
          } catch {
            return {
              observationId: obs.id,
              policyNames: [] as string[],
            };
          }
        }),
      );

      if (cancelled) return;

      setPolicyNamesByObservationId(
        Object.fromEntries(
          results.map((item) => [item.observationId, item.policyNames]),
        ),
      );
      setIsPolicyTypeLoading(false);
    };

    void fetchPolicyNames();

    return () => {
      cancelled = true;
    };
  }, [
    hasProjectAccess,
    policyViolationObservations,
    trace.projectId,
    trace.id,
  ]);

  const errorGroups = useMemo(() => {
    const observationById = new Map(observations.map((obs) => [obs.id, obs]));
    const groups = new Map<
      string,
      {
        type: string;
        count: number;
        nodes: Array<{ id: string; label: string }>;
      }
    >();

    errorObservationIds.forEach((id) => {
      const type = errorTypeByObservationId[id] ?? "unclassified";
      const observation = observationById.get(id);
      const label = observation?.name?.trim() || id;
      const existing = groups.get(type);

      if (existing) {
        existing.count += 1;
        existing.nodes.push({ id, label });
      } else {
        groups.set(type, {
          type,
          count: 1,
          nodes: [{ id, label }],
        });
      }
    });

    return [...groups.values()].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.type.localeCompare(b.type);
    });
  }, [errorObservationIds, errorTypeByObservationId, observations]);

  const activeErrorGroup = useMemo(
    () => errorGroups.find((group) => group.type === expandedErrorType) ?? null,
    [errorGroups, expandedErrorType],
  );

  useEffect(() => {
    if (!expandedErrorType) return;
    const stillExists = errorGroups.some(
      (group) => group.type === expandedErrorType,
    );
    if (!stillExists) {
      setExpandedErrorType(null);
    }
  }, [errorGroups, expandedErrorType]);

  const policyViolationGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        type: string;
        count: number;
        nodes: Array<{ id: string; label: string }>;
      }
    >();

    policyViolationObservations.forEach((obs) => {
      const fetchedPolicyNames = policyNamesByObservationId[obs.id] ?? [];
      const metadataPolicyNames = derivePolicyNamesFromMetadata(obs.metadata);
      const policyNames = (
        fetchedPolicyNames.length > 0 ? fetchedPolicyNames : metadataPolicyNames
      ).filter(Boolean);
      const normalizedPolicyNames =
        policyNames.length > 0 ? policyNames : ["unclassified"];

      for (const policyName of normalizedPolicyNames) {
        const existing = groups.get(policyName);
        const node = {
          id: obs.id,
          label: obs.name?.trim() || obs.id,
        };
        if (existing) {
          existing.count += 1;
          existing.nodes.push(node);
        } else {
          groups.set(policyName, {
            type: policyName,
            count: 1,
            nodes: [node],
          });
        }
      }
    });

    return [...groups.values()].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.type.localeCompare(b.type);
    });
  }, [policyViolationObservations, policyNamesByObservationId]);

  const activePolicyViolationGroup = useMemo(
    () =>
      policyViolationGroups.find(
        (group) => group.type === expandedPolicyViolationType,
      ) ?? null,
    [policyViolationGroups, expandedPolicyViolationType],
  );

  useEffect(() => {
    if (!expandedPolicyViolationType) return;
    const stillExists = policyViolationGroups.some(
      (group) => group.type === expandedPolicyViolationType,
    );
    if (!stillExists) {
      setExpandedPolicyViolationType(null);
    }
  }, [policyViolationGroups, expandedPolicyViolationType]);

  const enhancedGovernanceEnabled =
    errorAnalysisSettingsQuery.data?.enabled === true;
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {enhancedGovernanceEnabled ? (
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <span>Enhanced Governance Mode:</span>
            <span className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
              Active
            </span>
          </div>
        ) : null}
      </div>
      <div className="mt-1 text-sm text-muted-foreground">
        Governance Summary:{" "}
        <span className="font-bold text-foreground">{errorCount}</span> errors,{" "}
        <span className="font-bold text-foreground">{warningCount}</span>{" "}
        warnings,{" "}
        <span className="font-bold text-foreground">
          {policyViolationCount}
        </span>{" "}
        policy violations across{" "}
        <span className="font-bold text-foreground">{observations.length}</span>{" "}
        nodes.
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <span>Error node types:</span>
        {errorCount === 0 ? (
          <span className="font-bold text-foreground">none</span>
        ) : !hasProjectAccess ? (
          <span>unavailable (project access required)</span>
        ) : isErrorTypeLoading && errorGroups.length === 0 ? (
          <span>loading...</span>
        ) : (
          errorGroups.map((group) => {
            const isActive = expandedErrorType === group.type;
            return (
              <button
                key={group.type}
                type="button"
                className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-red-500 bg-red-100 text-red-700 dark:border-red-700 dark:bg-red-900/40 dark:text-red-300"
                    : "border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-900/40"
                }`}
                onClick={() =>
                  setExpandedErrorType((prev) =>
                    prev === group.type ? null : group.type,
                  )
                }
              >
                {group.type}({group.count})
              </button>
            );
          })
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <span>Policy violation node types:</span>
        {policyViolationCount === 0 ? (
          <span className="font-bold text-foreground">none</span>
        ) : isPolicyTypeLoading && policyViolationGroups.length === 0 ? (
          <span>loading...</span>
        ) : (
          policyViolationGroups.map((group) => {
            const isActive = expandedPolicyViolationType === group.type;
            return (
              <button
                key={group.type}
                type="button"
                className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-amber-500 bg-amber-100 text-amber-700 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                    : "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-900/40"
                }`}
                onClick={() =>
                  setExpandedPolicyViolationType((prev) =>
                    prev === group.type ? null : group.type,
                  )
                }
              >
                {group.type}({group.count})
              </button>
            );
          })
        )}
      </div>
      {activePolicyViolationGroup ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/40 p-2 dark:border-amber-900 dark:bg-amber-950/20">
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            {activePolicyViolationGroup.type} nodes (
            {activePolicyViolationGroup.count})
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {activePolicyViolationGroup.nodes.map((node) => {
              const isSelected = selectedNodeId === node.id;
              return (
                <button
                  key={node.id}
                  type="button"
                  className={`flex w-full flex-wrap items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs transition-colors ${
                    isSelected
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-muted"
                  }`}
                  onClick={() => setSelectedNodeId(node.id)}
                >
                  <span className="line-clamp-1 break-all">{node.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {activeErrorGroup ? (
        <div className="mt-2 rounded-md border border-red-200 bg-red-50/40 p-2 dark:border-red-900 dark:bg-red-950/20">
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            {activeErrorGroup.type} nodes ({activeErrorGroup.count})
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {activeErrorGroup.nodes.map((node) => {
              const isSelected = selectedNodeId === node.id;
              return (
                <button
                  key={node.id}
                  type="button"
                  className={`flex w-full items-start justify-between gap-2 rounded px-2 py-1 text-left text-xs transition-colors ${
                    isSelected
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-muted"
                  }`}
                  onClick={() => setSelectedNodeId(node.id)}
                >
                  <span className="line-clamp-1 break-all">{node.label}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {node.id}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
