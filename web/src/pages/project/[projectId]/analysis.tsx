import React, { useCallback, useMemo } from "react";
import { useRouter } from "next/router";
import Page from "@/src/components/layouts/page";
import { Tabs, TabsList, TabsTrigger } from "@/src/components/ui/tabs";
import { api } from "@/src/utils/api";
import { TracesOnboarding } from "@/src/components/onboarding/TracesOnboarding";
import { useV4Beta } from "@/src/features/events/hooks/useV4Beta";
import ObservationsEventsTable from "@/src/features/events/components/EventsTable";
import ObservationsTable from "@/src/components/table/use-cases/observations";
import type { ObservationLevelType } from "@langfuse/shared";

type AnalysisTab = "error" | "warning";

function toLevel(tab: AnalysisTab): ObservationLevelType {
  return tab === "warning" ? "WARNING" : "ERROR";
}

function parseTab(value: unknown): AnalysisTab {
  return value === "warning" ? "warning" : "error";
}

export default function AnalysisPage() {
  const router = useRouter();
  const projectId = router.query.projectId as string;
  const tab = useMemo(
    () => parseTab(router.query.analysisLevel),
    [router.query.analysisLevel],
  );
  const forcedLevel = useMemo(() => toLevel(tab), [tab]);
  const { isBetaEnabled } = useV4Beta();

  const { data: hasTracingConfigured, isLoading } =
    api.traces.hasTracingConfigured.useQuery(
      { projectId },
      {
        enabled: !!projectId,
        trpc: { context: { skipBatch: true } },
        refetchInterval: 10_000,
      },
    );

  const showOnboarding = !isLoading && !hasTracingConfigured;

  const setTab = useCallback(
    async (next: string) => {
      const nextTab = parseTab(next);
      await router.replace(
        {
          pathname: router.pathname,
          query: {
            ...router.query,
            analysisLevel: nextTab,
            // Reset pagination when switching between error/warning
            pageIndex: 0,
            page: 1,
          },
        },
        undefined,
        { shallow: true },
      );
    },
    [router],
  );

  return (
    <Page
      headerProps={{
        title: "Analysis",
      }}
      scrollable={showOnboarding}
    >
      {showOnboarding ? (
        <TracesOnboarding projectId={projectId} />
      ) : (
        <div className="flex h-full w-full flex-col">
          <div className="flex items-center justify-between px-3 pt-3">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="error">Error</TabsTrigger>
                <TabsTrigger value="warning">Warning</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {isBetaEnabled ? (
              <ObservationsEventsTable
                projectId={projectId}
                forcedLevel={forcedLevel}
                disableDefaultTypeFilter
                clearTypeFilter
                forceViewMode="observation"
                showOpenTraceButton
              />
            ) : (
              <ObservationsTable
                projectId={projectId}
                forcedLevel={forcedLevel}
                disableDefaultTypeFilter
                clearTypeFilter
                showOpenTraceButton
              />
            )}
          </div>
        </div>
      )}
    </Page>
  );
}
