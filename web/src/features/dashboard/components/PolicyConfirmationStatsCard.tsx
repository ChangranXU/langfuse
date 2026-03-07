import { useMemo } from "react";
import { type FilterState } from "@langfuse/shared";
import { api } from "@/src/utils/api";
import { DashboardCard } from "@/src/features/dashboard/components/cards/DashboardCard";
import { NoDataOrLoading } from "@/src/components/NoDataOrLoading";
import { TotalMetric } from "@/src/features/dashboard/components/TotalMetric";
import { compactNumberFormatter } from "@/src/utils/numbers";
import { cn } from "@/src/utils/tailwind";
import { type ViewVersion } from "@/src/features/query";

type PolicyStatsRow = {
  policyName: string;
  totalCount: number;
  acceptedCount: number;
  rejectedCount: number;
  acceptedRate: number;
  rejectedRate: number;
};

function formatRateWithCount(params: { count: number; total: number }) {
  const { count, total } = params;
  if (total <= 0) {
    return "0%(0/0)";
  }
  const percentage = (count / total) * 100;
  const rounded = Number.isInteger(percentage)
    ? percentage.toFixed(0)
    : percentage.toFixed(1);
  return `${rounded}%(${count}/${total})`;
}

function PolicyStatsTable(props: {
  rows: PolicyStatsRow[];
  highlightThresholdPct: number;
  className?: string;
}) {
  const { rows, highlightThresholdPct, className } = props;

  return (
    <div className={cn("max-h-80 min-h-0 flex-1 overflow-y-auto", className)}>
      <table className="w-full table-fixed divide-y divide-border">
        <colgroup>
          <col style={{ width: "32%" }} />
          <col style={{ width: "14%" }} />
          <col style={{ width: "27%" }} />
          <col style={{ width: "27%" }} />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-background">
          <tr>
            <th
              scope="col"
              className="py-3.5 pl-4 pr-3 text-center text-xs font-semibold text-primary sm:pl-0"
            >
              Policy
            </th>
            <th
              scope="col"
              className="py-3.5 pl-4 pr-3 text-center text-xs font-semibold text-primary sm:pl-0"
            >
              Total
            </th>
            <th
              scope="col"
              className="py-3.5 pl-4 pr-3 text-center text-xs font-semibold text-primary sm:pl-0"
            >
              Accepted
            </th>
            <th
              scope="col"
              className="py-3.5 pl-4 pr-3 text-center text-xs font-semibold text-primary sm:pl-0"
            >
              Rejected
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-accent bg-background">
          {rows.map((row) => {
            const shouldHighlight =
              row.rejectedRate * 100 >= highlightThresholdPct;
            return (
              <tr
                key={row.policyName}
                className={cn(
                  shouldHighlight && "bg-destructive/10 dark:bg-destructive/20",
                )}
              >
                <td className="py-2 pl-3 pr-2 text-center align-top text-xs text-foreground sm:pl-0">
                  <span
                    className="inline-block max-w-full truncate font-semibold"
                    title={row.policyName}
                  >
                    {row.policyName}
                  </span>
                </td>
                <td className="py-2 pl-3 pr-2 text-center align-top text-xs font-semibold text-foreground sm:pl-0">
                  {row.totalCount}
                </td>
                <td className="py-2 pl-3 pr-2 text-center align-top text-xs text-foreground sm:pl-0">
                  {formatRateWithCount({
                    count: row.acceptedCount,
                    total: row.totalCount,
                  })}
                </td>
                <td
                  className={cn(
                    "py-2 pl-3 pr-2 text-center align-top text-xs sm:pl-0",
                    shouldHighlight
                      ? "font-semibold text-destructive"
                      : "text-foreground",
                  )}
                >
                  {formatRateWithCount({
                    count: row.rejectedCount,
                    total: row.totalCount,
                  })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const PolicyConfirmationStatsCard = ({
  className,
  projectId,
  globalFilterState,
  fromTimestamp,
  toTimestamp,
  isLoading = false,
  metricsVersion,
}: {
  className?: string;
  projectId: string;
  globalFilterState: FilterState;
  fromTimestamp: Date;
  toTimestamp: Date;
  isLoading?: boolean;
  metricsVersion?: ViewVersion;
}) => {
  const settingsQuery = api.projects.getErrorAnalysisSettings.useQuery(
    { projectId },
    {
      enabled: !isLoading,
      refetchOnWindowFocus: false,
    },
  );

  const statsQuery = api.dashboard.policyConfirmationStats.useQuery(
    {
      projectId,
      globalFilterState,
      fromTimestamp,
      toTimestamp,
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

  const rows = useMemo<PolicyStatsRow[]>(
    () => (statsQuery.data as PolicyStatsRow[] | undefined) ?? [],
    [statsQuery.data],
  );

  const totalConfirmations = useMemo(
    () => rows.reduce((sum, row) => sum + row.totalCount, 0),
    [rows],
  );

  const highlightThresholdPct =
    settingsQuery.data?.policyRejectHighlightThresholdPct ?? 70;

  const isCardLoading =
    isLoading || settingsQuery.isPending || statsQuery.isPending;

  return (
    <DashboardCard
      className={className}
      title="Policy confirmation stats"
      description={`Sorted by rejected ratio (desc). Highlight threshold: ${highlightThresholdPct}%`}
      isLoading={isCardLoading}
      cardContentClassName="flex min-h-0 flex-1 flex-col"
    >
      {rows.length > 0 ? (
        <div className="mt-1 flex min-h-0 flex-1 flex-col">
          <TotalMetric
            metric={compactNumberFormatter(totalConfirmations)}
            description="Total policy confirmations (accepted + rejected)"
          />
          <div className="mt-3 min-h-0 flex-1">
            <PolicyStatsTable
              rows={rows}
              highlightThresholdPct={highlightThresholdPct}
            />
          </div>
        </div>
      ) : (
        <NoDataOrLoading
          isLoading={isCardLoading}
          description="No policy confirmations found in the selected range."
        />
      )}
    </DashboardCard>
  );
};
