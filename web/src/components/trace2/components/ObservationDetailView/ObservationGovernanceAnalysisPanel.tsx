import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/src/components/ui/badge";
import { Button } from "@/src/components/ui/button";
import { api } from "@/src/utils/api";
import { ChevronDown, ChevronUp } from "lucide-react";

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
      // ignore invalid metadata string
    }
  }

  return {};
}

type PolicyAction = {
  tool: string;
  reason: string;
};

function derivePolicyActions(policyReason: string | null): PolicyAction[] {
  if (!policyReason) return [];

  const pattern =
    /POLICY_BLOCK\s+tool=(\S+)\s+reason=([\s\S]*?)(?=\s+POLICY_BLOCK\s+tool=|$)/g;
  const results: PolicyAction[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null = pattern.exec(policyReason);
  while (match) {
    const tool = match[1]?.trim();
    const reason = match[2]?.replace(/\s+/g, " ").trim();
    if (tool && reason) {
      const key = `${tool}::${reason}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ tool, reason });
      }
    }
    match = pattern.exec(policyReason);
  }
  return results;
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

export function ObservationGovernanceAnalysisPanel(props: {
  projectId: string;
  traceId: string;
  observationId: string;
  level: string | null | undefined;
  statusMessage: string | null | undefined;
  metadata: unknown;
  traceMetadata?: unknown;
  hasProjectAccess: boolean;
}) {
  const isPolicyViolation = props.level === "POLICY_VIOLATION";
  const isGovernanceLevel =
    props.level === "ERROR" || props.level === "WARNING" || isPolicyViolation;

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

  const statusMessage = props.statusMessage?.trim();
  const [isOutputExpanded, setIsOutputExpanded] = useState(false);
  const observationPolicyMetadata = useMemo(
    () => getMetadataRecord(props.metadata),
    [props.metadata],
  );
  const tracePolicyMetadata = useMemo(
    () => getMetadataRecord(props.traceMetadata),
    [props.traceMetadata],
  );
  const policyMetadata = useMemo(
    () =>
      isPolicyViolation
        ? observationPolicyMetadata
        : {
            ...tracePolicyMetadata,
            ...observationPolicyMetadata,
          },
    [isPolicyViolation, observationPolicyMetadata, tracePolicyMetadata],
  );
  const policyProtectedReason = useMemo(() => {
    const value = policyMetadata.policy_protected;
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (statusMessage?.includes("POLICY_BLOCK")) {
      return statusMessage;
    }
    return null;
  }, [policyMetadata.policy_protected, statusMessage]);
  const policyNames = useMemo(
    () => [
      ...new Set([
        ...parseStringArray(policyMetadata.policy_names),
        ...parseStringArray(policyMetadata.policy_name),
      ]),
    ],
    [policyMetadata.policy_name, policyMetadata.policy_names],
  );
  const policyDescriptions = useMemo(
    () => parseStringRecord(policyMetadata.policy_descriptions),
    [policyMetadata.policy_descriptions],
  );
  const policySources = useMemo(
    () => parseStringRecord(policyMetadata.policy_sources),
    [policyMetadata.policy_sources],
  );
  const policyNameList = useMemo(() => {
    const names = new Set(policyNames);
    Object.keys(policyDescriptions).forEach((name) => names.add(name));
    Object.keys(policySources).forEach((name) => names.add(name));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [policyDescriptions, policyNames, policySources]);

  if (!isGovernanceLevel) {
    return null;
  }

  const panelTitle = isPolicyViolation
    ? "Policy Enforcement"
    : "Governance Analysis & Suggestion";
  const panelSubtitle = isPolicyViolation
    ? "This node was blocked by policy. Action shows what was prevented."
    : "Node-level diagnostics and mitigation guidance for this failure.";

  const rawOutputContent = statusMessage ?? null;
  const policyActions = useMemo(
    () => derivePolicyActions(policyProtectedReason),
    [policyProtectedReason],
  );
  const policyActionFallback = useMemo(() => {
    if (policyActions.length > 0 || !policyProtectedReason) return null;
    const compact = policyProtectedReason
      .replace(/^POLICY_[A-Z_]+\s+/i, "")
      .replace(/\s+/g, " ")
      .trim();
    return compact || null;
  }, [policyActions, policyProtectedReason]);
  const normalizedPolicyProtectedLines = useMemo(() => {
    if (policyActions.length > 0) {
      return policyActions.map(
        (item) => `POLICY_BLOCK tool=${item.tool} reason=${item.reason}`,
      );
    }
    if (!policyProtectedReason) return [];
    const normalized = policyProtectedReason
      .replace(/\r\n/g, "\n")
      .replace(/\s*POLICY_BLOCK\s+tool=/g, "\nPOLICY_BLOCK tool=")
      .trim();
    if (!normalized) return [];
    return Array.from(
      new Set(
        normalized
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    );
  }, [policyActions, policyProtectedReason]);
  const canExpandOutput = useMemo(() => {
    if (!rawOutputContent) return false;
    if (rawOutputContent.length > 180) return true;
    const lines = rawOutputContent.split("\n").length;
    return lines > 6;
  }, [rawOutputContent]);

  useEffect(() => {
    setIsOutputExpanded(false);
  }, [props.observationId]);

  return (
    <div className="h-full min-h-0 min-w-0 p-2">
      <div className="h-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden rounded-md border bg-muted/20 p-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">{panelTitle}</div>
            <div className="text-xs text-muted-foreground">{panelSubtitle}</div>
          </div>
          <Badge
            variant={
              props.level === "ERROR"
                ? "destructive"
                : props.level === "WARNING" || isPolicyViolation
                  ? "warning"
                  : "secondary"
            }
          >
            {props.level}
          </Badge>
        </div>

        <div className="space-y-3">
          {isPolicyViolation ? (
            <div>
              <div className="mb-1 min-w-0 text-xs font-medium text-muted-foreground">
                Action
              </div>
              <div className="min-w-0 rounded-md border bg-background p-2 text-sm">
                {policyActions.length > 0 ? (
                  <div className="space-y-2">
                    {policyActions.map((action, idx) => (
                      <div
                        key={`policy-action-${idx}`}
                        className="flex flex-wrap items-center gap-2 rounded border border-amber-200 bg-amber-50/50 px-2 py-1 text-xs dark:border-amber-900 dark:bg-amber-950/20"
                      >
                        <Badge
                          variant="warning"
                          className="font-mono text-[10px]"
                        >
                          {action.tool}
                        </Badge>
                        <span className="break-words text-muted-foreground">
                          {action.reason}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : policyActionFallback ? (
                  <div className="font-mono text-xs text-muted-foreground">
                    {policyActionFallback}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    Not available
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <div>
            <div className="mb-1 min-w-0 text-xs font-medium text-muted-foreground">
              {isPolicyViolation ? "Policy Details" : "Output"}
            </div>
            {isPolicyViolation ? (
              <div className="divide-y rounded-md border bg-background text-xs">
                <div className="space-y-2 p-3">
                  <div className="text-sm font-semibold text-foreground">
                    Policy Protected
                  </div>
                  {normalizedPolicyProtectedLines.length > 0 ? (
                    <div className="mt-1 space-y-1">
                      {normalizedPolicyProtectedLines.map((line, idx) => (
                        <div
                          key={`policy-protected-line-${idx}`}
                          className="whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground"
                        >
                          {line}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1 text-muted-foreground">
                      Not available
                    </div>
                  )}
                </div>
                <div className="space-y-2 p-3">
                  <div className="text-sm font-semibold text-foreground">
                    Policy Names
                  </div>
                  {policyNameList.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {policyNameList.map((policyName) => (
                        <Badge
                          key={`policy-name-${policyName}`}
                          variant="warning"
                        >
                          {policyName}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1 text-muted-foreground">
                      Not available
                    </div>
                  )}
                </div>
                <div className="space-y-2 p-3">
                  <div className="text-sm font-semibold text-foreground">
                    Policy Descriptions
                  </div>
                  <div className="space-y-1 text-muted-foreground">
                    {policyNameList.length > 0 ? (
                      policyNameList.map((policyName) => (
                        <div key={`policy-description-${policyName}`}>
                          <span className="font-medium text-foreground">
                            {policyName}:
                          </span>{" "}
                          {policyDescriptions[policyName] ?? "Not available"}
                        </div>
                      ))
                    ) : (
                      <div>Not available</div>
                    )}
                  </div>
                </div>
                <div className="space-y-2 p-3">
                  <div className="text-sm font-semibold text-foreground">
                    Policy Sources
                  </div>
                  <div className="space-y-2 text-muted-foreground">
                    {policyNameList.length > 0 ? (
                      policyNameList.map((policyName) => (
                        <div
                          key={`policy-source-${policyName}`}
                          className="rounded border bg-muted/20 p-2"
                        >
                          <div className="font-medium text-foreground">
                            {policyName}
                          </div>
                          <div className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                            {policySources[policyName] ?? "Not available"}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div>Not available</div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
            {!isPolicyViolation && rawOutputContent ? (
              <div className="rounded-md border bg-background">
                <div
                  className={`whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-muted-foreground ${
                    isOutputExpanded ? "block" : "line-clamp-6"
                  }`}
                  onClick={() => {
                    if (!isOutputExpanded && canExpandOutput) {
                      setIsOutputExpanded(true);
                    }
                  }}
                >
                  {rawOutputContent}
                </div>
                {canExpandOutput ? (
                  <div className="flex justify-center px-2 pb-2">
                    <Button
                      variant="secondary"
                      size="icon-xs"
                      onClick={() => setIsOutputExpanded((prev) => !prev)}
                      title={isOutputExpanded ? "Collapse" : "Expand"}
                    >
                      {isOutputExpanded ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : !isPolicyViolation ? (
              <div className="min-w-0 rounded-md border bg-background p-2 text-xs text-muted-foreground">
                No status message available.
              </div>
            ) : null}
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
          ) : null}
        </div>
      </div>
    </div>
  );
}
