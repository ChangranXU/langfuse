import { useEffect, useMemo, useState } from "react";
import { api, directApi } from "@/src/utils/api";
import { useIsAuthenticatedAndProjectMember } from "@/src/features/auth/hooks";
import { useTraceData } from "@/src/components/trace2/contexts/TraceDataContext";
import { useSelection } from "@/src/components/trace2/contexts/SelectionContext";

const GOVERNANCE_REFRESH_INTERVAL_MS = 5_000;

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

  const errorAnalysisSettingsQuery =
    api.projects.getErrorAnalysisSettings.useQuery(
      { projectId: trace.projectId },
      {
        enabled: hasProjectAccess,
        refetchOnWindowFocus: false,
        retry: false,
      },
    );

  const { errorCount, warningCount, errorObservationIds } = useMemo(() => {
    const errorObservations = observations.filter(
      (obs) => obs.level === "ERROR",
    );
    const errorCount = errorObservations.length;
    const warningCount = observations.filter(
      (obs) => obs.level === "WARNING",
    ).length;

    return {
      errorCount,
      warningCount,
      errorObservationIds: errorObservations.map((obs) => obs.id),
    };
  }, [observations]);

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
        Governance Summary: {errorCount} errors, {warningCount} warnings across{" "}
        {observations.length} nodes.
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <span>Error node types:</span>
        {errorCount === 0 ? (
          <span>none</span>
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
