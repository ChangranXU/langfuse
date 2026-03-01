import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/card";
import { NoDataOrLoading } from "@/src/components/NoDataOrLoading";
import { DashboardCard } from "@/src/features/dashboard/components/cards/DashboardCard";
import { Chart } from "@/src/features/widgets/chart-library/Chart";
import { api } from "@/src/utils/api";
import { compactNumberFormatter } from "@/src/utils/numbers";
import {
  dashboardDateRangeAggregationSettings,
  type DashboardDateRangeAggregationOption,
} from "@/src/utils/date-range-utils";
import {
  type QueryType,
  type ViewVersion,
  mapLegacyUiTableFilterToView,
} from "@/src/features/query";
import { type FilterState } from "@langfuse/shared";
import { type DataPoint } from "@/src/features/widgets/chart-library/chart-props";

function getSafeIsoTime(value: unknown): string {
  const asString = String(value);
  const parsed = new Date(asString);
  if (Number.isNaN(parsed.getTime())) return asString;
  return parsed.toISOString();
}

export function GovernanceOverviewPanel(props: {
  projectId: string;
  globalFilterState: FilterState;
  fromTimestamp: Date;
  toTimestamp: Date;
  agg: DashboardDateRangeAggregationOption;
  isLoading?: boolean;
  metricsVersion?: ViewVersion;
}) {
  const {
    projectId,
    globalFilterState,
    fromTimestamp,
    toTimestamp,
    agg,
    isLoading = false,
    metricsVersion,
  } = props;

  const observationsQuery: QueryType = {
    view: "observations",
    dimensions: [{ field: "level" }],
    metrics: [{ measure: "count", aggregation: "count" }],
    filters: mapLegacyUiTableFilterToView("observations", globalFilterState),
    timeDimension: {
      granularity:
        dashboardDateRangeAggregationSettings[agg].dateTrunc ?? "day",
    },
    fromTimestamp: fromTimestamp.toISOString(),
    toTimestamp: toTimestamp.toISOString(),
    orderBy: null,
  };

  const observations = api.dashboard.executeQuery.useQuery(
    {
      projectId,
      query: observationsQuery,
      version: metricsVersion,
    },
    {
      trpc: {
        context: {
          skipBatch: true,
        },
      },
      enabled: !isLoading,
    },
  );

  const settingsQuery = api.projects.getErrorAnalysisSettings.useQuery(
    { projectId },
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
    },
  );

  const summaryQuery = api.experienceSummary.get.useQuery(
    { projectId },
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
    },
  );

  const {
    errorCount,
    warningCount,
    governedCount,
    trendData,
    hasTrendData,
    latestErrors,
    latestWarnings,
  } = useMemo(() => {
    const rows = observations.data ?? [];
    let errorCount = 0;
    let warningCount = 0;

    const groupedByTime = new Map<string, { ERROR: number; WARNING: number }>();
    for (const row of rows) {
      const level = String(row.level ?? "").toUpperCase();
      if (level !== "ERROR" && level !== "WARNING") continue;

      const value = Number(row.count_count ?? 0);
      const timeKey = getSafeIsoTime(row.time_dimension);
      const current = groupedByTime.get(timeKey) ?? { ERROR: 0, WARNING: 0 };
      current[level as "ERROR" | "WARNING"] += value;
      groupedByTime.set(timeKey, current);

      if (level === "ERROR") errorCount += value;
      if (level === "WARNING") warningCount += value;
    }

    const sortedTimes = [...groupedByTime.keys()].sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    );
    const trendData: DataPoint[] = [];
    for (const time of sortedTimes) {
      const group = groupedByTime.get(time)!;
      trendData.push({
        time_dimension: time,
        dimension: "Errors",
        metric: group.ERROR,
      });
      trendData.push({
        time_dimension: time,
        dimension: "Warnings",
        metric: group.WARNING,
      });
    }

    const latestTime =
      sortedTimes.length > 0 ? sortedTimes[sortedTimes.length - 1] : null;
    const latest = latestTime ? groupedByTime.get(latestTime) : null;

    return {
      errorCount,
      warningCount,
      governedCount: errorCount + warningCount,
      trendData,
      hasTrendData: trendData.length > 0,
      latestErrors: latest?.ERROR ?? 0,
      latestWarnings: latest?.WARNING ?? 0,
    };
  }, [observations.data]);

  const experiencePackCount =
    summaryQuery.data?.summary.experiences.length ?? 0;
  const promptPackLineCount =
    summaryQuery.data?.summary.promptPack.lines.length ?? 0;
  const isPanelLoading =
    isLoading ||
    observations.isPending ||
    settingsQuery.isPending ||
    summaryQuery.isPending;

  return (
    <div className="mb-3 space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Governed Signals</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {compactNumberFormatter(governedCount)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              ERROR + WARNING observations in selected range
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Errors</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-destructive">
              {compactNumberFormatter(errorCount)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Latest bucket: {compactNumberFormatter(latestErrors)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Warnings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-yellow-600 dark:text-yellow-400">
              {compactNumberFormatter(warningCount)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Latest bucket: {compactNumberFormatter(latestWarnings)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Governance Assets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">
              {compactNumberFormatter(experiencePackCount)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Experience packs · {compactNumberFormatter(promptPackLineCount)}{" "}
              prompt lines
            </div>
          </CardContent>
        </Card>
      </div>

      <DashboardCard
        title="Governance Trend"
        description="Error/Warning changes over time with governance monitoring."
        isLoading={isPanelLoading}
      >
        {hasTrendData ? (
          <div className="h-72 w-full">
            <Chart
              chartType="LINE_TIME_SERIES"
              data={trendData}
              rowLimit={240}
              chartConfig={{
                type: "LINE_TIME_SERIES",
                show_data_point_dots: false,
              }}
              legendPosition="above"
            />
          </div>
        ) : (
          <NoDataOrLoading
            isLoading={isPanelLoading}
            description="No ERROR/WARNING observations found in the current time range."
          />
        )}
      </DashboardCard>
    </div>
  );
}
