import { useMemo, useState } from "react";
import { type FilterState } from "@langfuse/shared";
import { api } from "@/src/utils/api";
import { DashboardCard } from "@/src/features/dashboard/components/cards/DashboardCard";
import { NoDataOrLoading } from "@/src/components/NoDataOrLoading";
import { TotalMetric } from "@/src/features/dashboard/components/TotalMetric";
import { compactNumberFormatter } from "@/src/utils/numbers";
import { cn } from "@/src/utils/tailwind";
import { type ViewVersion } from "@/src/features/query";
import { PolicyConfirmationDetailsSheet } from "@/src/features/dashboard/components/PolicyConfirmationDetailsSheet";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/src/components/ui/alert-dialog";
import { Button } from "@/src/components/ui/button";

type PolicyStatsRow = {
  policyName: string;
  totalCount: number;
  acceptedCount: number;
  rejectedCount: number;
  acceptedRate: number;
  rejectedRate: number;
};

type PolicyConfirmationState = "accepted" | "rejected";

function formatRateWithCount(params: {
  count: number;
  total: number;
  onCountClick?: () => void;
}) {
  const { count, total, onCountClick } = params;
  if (total <= 0) {
    return (
      <>
        <span className="font-semibold">0%</span>(0/0)
      </>
    );
  }
  const percentage = (count / total) * 100;
  const rounded = Number.isInteger(percentage)
    ? percentage.toFixed(0)
    : percentage.toFixed(1);
  return (
    <>
      <span className="font-semibold">{rounded}%</span>(
      {count > 0 && onCountClick ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onCountClick();
          }}
          className="font-semibold underline underline-offset-2 hover:text-primary"
        >
          {count}
        </button>
      ) : (
        <span className="font-semibold">{count}</span>
      )}
      /{total})
    </>
  );
}

function PolicyStatsTable(props: {
  rows: PolicyStatsRow[];
  highlightThresholdPct: number;
  className?: string;
  onCountClick: (params: {
    policyName: string;
    state: PolicyConfirmationState;
  }) => void;
  onHighlightedRowClick?: (policyName: string) => void;
}) {
  const {
    rows,
    highlightThresholdPct,
    className,
    onCountClick,
    onHighlightedRowClick,
  } = props;

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
            const isClickable =
              shouldHighlight && Boolean(onHighlightedRowClick);
            return (
              <tr
                key={row.policyName}
                className={cn(
                  shouldHighlight && "bg-destructive/10 dark:bg-destructive/20",
                  isClickable &&
                    "cursor-pointer hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:hover:bg-destructive/30",
                )}
                role={isClickable ? "button" : undefined}
                tabIndex={isClickable ? 0 : undefined}
                onClick={() => {
                  if (isClickable) {
                    onHighlightedRowClick?.(row.policyName);
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    isClickable &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    onHighlightedRowClick?.(row.policyName);
                  }
                }}
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
                    onCountClick: () =>
                      onCountClick({
                        policyName: row.policyName,
                        state: "accepted",
                      }),
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
                    onCountClick: () =>
                      onCountClick({
                        policyName: row.policyName,
                        state: "rejected",
                      }),
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
  const [selectedDetail, setSelectedDetail] = useState<{
    policyName: string;
    state: PolicyConfirmationState;
  } | null>(null);
  const [selectedSuggestionPolicyName, setSelectedSuggestionPolicyName] =
    useState<string | null>(null);
  const suggestionMutation = api.policySuggestions.generate.useMutation();

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
              onCountClick={setSelectedDetail}
              onHighlightedRowClick={(policyName) => {
                suggestionMutation.reset();
                setSelectedSuggestionPolicyName(policyName);
              }}
            />
          </div>
        </div>
      ) : (
        <NoDataOrLoading
          isLoading={isCardLoading}
          description="No policy confirmations found in the selected range."
        />
      )}
      {selectedDetail ? (
        <PolicyConfirmationDetailsSheet
          open={!!selectedDetail}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedDetail(null);
            }
          }}
          projectId={projectId}
          policyName={selectedDetail.policyName}
          state={selectedDetail.state}
          globalFilterState={globalFilterState}
          fromTimestamp={fromTimestamp}
          toTimestamp={toTimestamp}
          metricsVersion={metricsVersion}
        />
      ) : null}
      <AlertDialog
        open={Boolean(selectedSuggestionPolicyName)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSuggestionPolicyName(null);
            suggestionMutation.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Policy refinement suggestion</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedSuggestionPolicyName
                ? `User feedback indicates potential dissatisfaction with "${selectedSuggestionPolicyName}". Would you like to review and refine this policy with LLM-assisted suggestions?`
                : "Generate a policy refinement suggestion from rejected-turn evidence."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {suggestionMutation.isPending ? (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              Generating suggestion from policy enforcement context...
            </div>
          ) : null}
          {suggestionMutation.error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {suggestionMutation.error.message}
            </div>
          ) : null}
          {suggestionMutation.data ? (
            <div className="space-y-3 rounded-md border bg-muted/30 p-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Suggestion
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                  {suggestionMutation.data.suggestion.suggestion}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Reason
                </div>
                <div className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                  {suggestionMutation.data.suggestion.reason}
                </div>
              </div>
              {suggestionMutation.data.suggestion.supportingSignals.length >
              0 ? (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Supporting signals
                  </div>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {suggestionMutation.data.suggestion.supportingSignals.map(
                      (signal, idx) => (
                        <li key={`${signal}-${idx}`}>{signal}</li>
                      ),
                    )}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={suggestionMutation.isPending}>
              {suggestionMutation.data ? "Close" : "No"}
            </AlertDialogCancel>
            <Button
              type="button"
              disabled={
                suggestionMutation.isPending || !selectedSuggestionPolicyName
              }
              onClick={() => {
                if (!selectedSuggestionPolicyName) return;
                suggestionMutation.mutate({
                  projectId,
                  policyName: selectedSuggestionPolicyName,
                  globalFilterState,
                  fromTimestamp,
                  toTimestamp,
                  version: metricsVersion,
                });
              }}
            >
              {suggestionMutation.isPending
                ? "Generating..."
                : suggestionMutation.data
                  ? "Regenerate with latest context"
                  : "Yes, generate suggestion"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardCard>
  );
};
