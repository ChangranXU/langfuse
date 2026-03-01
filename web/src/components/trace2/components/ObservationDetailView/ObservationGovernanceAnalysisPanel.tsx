import { useMemo } from "react";
import Link from "next/link";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { CodeView } from "@/src/components/ui/CodeJsonViewer";
import { api } from "@/src/utils/api";
import { ErrorAnalysisButton } from "@/src/features/error-analysis/components/ErrorAnalysisButton";

function truncateValue(value: string, maxChars = 4000) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function getExperienceAnchorId(key: string) {
  return `experience-pack-${key}`;
}

export function ObservationGovernanceAnalysisPanel(props: {
  projectId: string;
  traceId: string;
  observationId: string;
  level: string | null | undefined;
  statusMessage: string | null | undefined;
  hasProjectAccess: boolean;
}) {
  const isGovernanceLevel =
    props.level === "ERROR" || props.level === "WARNING";

  const canQueryGovernance = props.hasProjectAccess && isGovernanceLevel;
  const errorAnalysisQuery = api.errorAnalysis.get.useQuery(
    {
      projectId: props.projectId,
      traceId: props.traceId,
      observationId: props.observationId,
    },
    {
      enabled: canQueryGovernance,
      refetchOnWindowFocus: false,
    },
  );

  const experienceSummaryQuery = api.experienceSummary.get.useQuery(
    { projectId: props.projectId },
    {
      enabled: canQueryGovernance,
      refetchOnWindowFocus: false,
    },
  );

  const relatedExperiences = useMemo(() => {
    const summary = experienceSummaryQuery.data?.summary;
    if (!summary) return [];

    const errorType = errorAnalysisQuery.data?.rendered.errorType;
    if (!errorType) {
      return summary.experiences.slice(0, 3);
    }

    const related = summary.experiences.filter((experience) =>
      (experience.relatedErrorTypes ?? []).includes(errorType),
    );

    return (related.length > 0 ? related : summary.experiences).slice(0, 3);
  }, [
    experienceSummaryQuery.data?.summary,
    errorAnalysisQuery.data?.rendered.errorType,
  ]);

  const statusMessage = props.statusMessage?.trim();
  const relatedExperienceAnchor =
    relatedExperiences.length > 0
      ? getExperienceAnchorId(relatedExperiences[0]!.key)
      : null;

  if (!isGovernanceLevel) {
    return null;
  }

  return (
    <div className="h-full min-h-0 min-w-0 p-2">
      <div className="h-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden rounded-md border bg-muted/20 p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              Governance Analysis & Suggestion
            </div>
            <div className="text-xs text-muted-foreground">
              Node-level diagnostics and mitigation guidance for this failure.
            </div>
          </div>
          <Badge variant={props.level === "ERROR" ? "destructive" : "warning"}>
            {props.level}
          </Badge>
        </div>

        <div className="space-y-3">
          <div>
            <div className="mb-1 min-w-0 text-xs font-medium text-muted-foreground">
              Raw Error Output
            </div>
            {statusMessage ? (
              <CodeView content={truncateValue(statusMessage)} scrollable />
            ) : (
              <div className="min-w-0 rounded-md border bg-background p-2 text-xs text-muted-foreground">
                No status message available.
              </div>
            )}
          </div>

          {!canQueryGovernance ? (
            <div className="min-w-0 rounded-md border bg-background p-2 text-xs text-muted-foreground">
              Governance analysis is available for project members.
            </div>
          ) : errorAnalysisQuery.isLoading ? (
            <div className="min-w-0 rounded-md border bg-background p-2 text-xs text-muted-foreground">
              Loading governance analysis...
            </div>
          ) : errorAnalysisQuery.data ? (
            <div className="min-w-0">
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                Analysis
              </div>
              <div className="min-w-0 rounded-md border bg-background p-2 text-sm">
                <div className="font-medium">Root cause</div>
                <div className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                  {errorAnalysisQuery.data.rendered.rootCause}
                </div>

                {errorAnalysisQuery.data.rendered.resolveNow.length > 0 && (
                  <div className="mt-3">
                    <div className="text-xs font-medium">Resolve now</div>
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {errorAnalysisQuery.data.rendered.resolveNow.map(
                        (item, idx) => (
                          <li
                            key={`resolve-now-${idx}`}
                            className="break-words"
                          >
                            {item}
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                )}

                {errorAnalysisQuery.data.rendered.preventionNextCall.length >
                  0 && (
                  <div className="mt-3">
                    <div className="text-xs font-medium">
                      Prevention next call
                    </div>
                    <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {errorAnalysisQuery.data.rendered.preventionNextCall.map(
                        (item, idx) => (
                          <li
                            key={`prevention-next-call-${idx}`}
                            className="break-words"
                          >
                            {item}
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="min-w-0 rounded-md border bg-background p-2">
              <div className="text-xs text-muted-foreground">
                No saved governance analysis yet.
              </div>
              <div className="mt-2">
                <ErrorAnalysisButton
                  projectId={props.projectId}
                  traceId={props.traceId}
                  observationId={props.observationId}
                  level={props.level}
                />
              </div>
            </div>
          )}

          {canQueryGovernance ? (
            <div className="min-w-0">
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                Related experience pack
              </div>
              {relatedExperiences.length > 0 ? (
                <div className="min-w-0 space-y-2 rounded-md border bg-background p-2">
                  {relatedExperiences.map((experience) => (
                    <div key={experience.key} className="min-w-0">
                      <div className="break-all text-sm font-medium">
                        {experience.key}
                      </div>
                      <div className="break-words text-xs text-muted-foreground">
                        {experience.when}
                      </div>
                    </div>
                  ))}
                  <Button asChild variant="outline" size="sm" className="mt-1">
                    <Link
                      href={
                        relatedExperienceAnchor
                          ? `/project/${props.projectId}/experience#${relatedExperienceAnchor}`
                          : `/project/${props.projectId}/experience`
                      }
                    >
                      Open experience packs
                    </Link>
                  </Button>
                </div>
              ) : (
                <div className="rounded-md border bg-background p-2 text-xs text-muted-foreground">
                  No experience pack available yet for this project.
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
