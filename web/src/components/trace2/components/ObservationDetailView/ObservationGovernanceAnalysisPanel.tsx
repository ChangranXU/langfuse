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

const POLICY_SIGNAL_STOPWORDS = new Set([
  "policy",
  "policy_block",
  "policy_transform",
  "tool",
  "tools",
  "reason",
  "path",
  "paths",
  "blocked",
  "block",
  "allow",
  "deny",
  "prefixes",
  "outside",
  "requested",
  "execution",
  "not",
  "in",
]);

function extractExplicitPolicySignals(policyReason: string): string[] {
  const reason = policyReason.toLowerCase();
  const signals: string[] = [];

  // Explicit dotted key path signals, e.g. "paths.allow_prefixes"
  const dottedMatches = reason.match(
    /\b[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\b/g,
  );
  if (dottedMatches) {
    for (const match of dottedMatches) {
      const signal = match.trim();
      if (!signal) continue;
      signals.push(signal);
    }
  }

  // Explicit snake_case signals, e.g. "allow_prefixes", "max_chars"
  const snakeMatches = reason.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g);
  if (snakeMatches) {
    for (const match of snakeMatches) {
      const signal = match.trim();
      if (!signal || POLICY_SIGNAL_STOPWORDS.has(signal)) continue;
      signals.push(signal);
    }
  }

  // "schema read" => "schemas.read"
  const schemaMatches = reason.match(/\bschema\s+([a-z][a-z0-9_]*)\b/g);
  if (schemaMatches) {
    for (const match of schemaMatches) {
      const schemaName = match.replace(/^schema\s+/i, "").trim();
      if (!schemaName || POLICY_SIGNAL_STOPWORDS.has(schemaName)) continue;
      signals.push(`schemas.${schemaName}`);
    }
  }

  return [...new Set(signals)];
}

function setNestedValue(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  if (path.length === 0) return;
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const current = cursor[key];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]!] = value;
}

function doesPathMatchSignal(path: string[], signal: string): boolean {
  const pathStr = path.join(".");
  if (signal.includes(".")) {
    return (
      pathStr === signal ||
      pathStr.startsWith(`${signal}.`) ||
      pathStr.endsWith(`.${signal}`) ||
      pathStr.includes(`.${signal}.`)
    );
  }
  return path.includes(signal);
}

function compactPolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length <= 20) return value;
    return [...value.slice(0, 20), "... truncated ..."];
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length <= 12) return value;
  return {
    ...Object.fromEntries(entries.slice(0, 12)),
    _truncated: true,
  };
}

function collectMatchedPolicyPaths(
  value: unknown,
  signals: string[],
  path: string[] = [],
  out: string[][] = [],
  maxMatches = 8,
): string[][] {
  if (out.length >= maxMatches || !value || typeof value !== "object")
    return out;
  if (Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (out.length >= maxMatches) break;
    const nextPath = [...path, key];
    const isMatch = signals.some((signal) =>
      doesPathMatchSignal(nextPath, signal),
    );
    if (isMatch) {
      out.push(nextPath);
    }
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      collectMatchedPolicyPaths(child, signals, nextPath, out, maxMatches);
    }
  }
  return out;
}

function extractRelevantPolicyData(params: {
  policyReason: string | null;
  policyConfig: unknown;
}): { description: string | null; snippet: string | null } {
  const { policyReason, policyConfig } = params;
  if (!policyReason || !policyReason.trim()) {
    return { description: null, snippet: null };
  }

  const compactReason = policyReason.replace(/\s+/g, " ").trim();
  if (!policyConfig || typeof policyConfig !== "object") {
    return { description: `Matched policy: ${compactReason}`, snippet: null };
  }

  const configRecord = policyConfig as Record<string, unknown>;
  const signals = extractExplicitPolicySignals(compactReason);
  const matchedPaths = collectMatchedPolicyPaths(configRecord, signals);

  if (matchedPaths.length === 0) {
    return { description: `Matched policy: ${compactReason}`, snippet: null };
  }

  const snippetObj: Record<string, unknown> = {};
  for (const path of matchedPaths) {
    let current: unknown = configRecord;
    let exists = true;
    for (const segment of path) {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        exists = false;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    if (!exists) continue;
    setNestedValue(snippetObj, path, compactPolicyValue(current));
  }

  const matchedPathLabels = matchedPaths.map((path) => path.join("."));
  return {
    description: `Matched policy keys: ${matchedPathLabels.join(", ")}.`,
    snippet:
      Object.keys(snippetObj).length > 0
        ? JSON.stringify(snippetObj, null, 2)
        : null,
  };
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
    () => ({
      ...tracePolicyMetadata,
      ...observationPolicyMetadata,
    }),
    [tracePolicyMetadata, observationPolicyMetadata],
  );
  const policyProtectedReason = useMemo(() => {
    const value = policyMetadata.policy_protected;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }, [policyMetadata]);
  const { description: matchedPolicyDescription, snippet: policyJsonSnippet } =
    useMemo(
      () =>
        extractRelevantPolicyData({
          policyReason: policyProtectedReason,
          policyConfig: policyMetadata.policy_config,
        }),
      [policyProtectedReason, policyMetadata.policy_config],
    );

  if (!isGovernanceLevel) {
    return null;
  }

  const panelTitle = isPolicyViolation
    ? "Policy Enforcement"
    : "Governance Analysis & Suggestion";
  const panelSubtitle = isPolicyViolation
    ? "This node was blocked by policy. Action shows what was prevented."
    : "Node-level diagnostics and mitigation guidance for this failure.";

  const rawOutputContent = useMemo(() => {
    if (isPolicyViolation) {
      if (policyJsonSnippet) {
        return policyJsonSnippet;
      }
      const raw = policyMetadata.raw_output_content;
      if (typeof raw === "string" && raw.trim()) {
        return raw;
      }
      if (policyProtectedReason) {
        return policyProtectedReason;
      }
    }

    return statusMessage ?? null;
  }, [
    isPolicyViolation,
    policyJsonSnippet,
    policyMetadata.raw_output_content,
    policyProtectedReason,
    statusMessage,
  ]);
  const policyActions = useMemo(
    () => derivePolicyActions(policyProtectedReason),
    [policyProtectedReason],
  );
  const policyActionLines = useMemo(() => {
    if (policyActions.length > 0) {
      return policyActions.map((item) => `${item.tool}: ${item.reason}`);
    }
    if (policyProtectedReason) {
      const compact = policyProtectedReason
        .replace(/^POLICY_[A-Z_]+\s+/i, "")
        .replace(/\s+/g, " ")
        .trim();
      return compact ? [compact] : [];
    }
    return [];
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
                {policyActionLines.length > 0 ? (
                  <div className="space-y-1 font-mono text-xs text-muted-foreground">
                    {policyActionLines.map((line, idx) => (
                      <div
                        key={`policy-action-line-${idx}`}
                        className="break-words"
                      >
                        {line}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div>
            <div className="mb-1 min-w-0 text-xs font-medium text-muted-foreground">
              {isPolicyViolation ? "Policy Details" : "Output"}
            </div>
            {isPolicyViolation && matchedPolicyDescription ? (
              <div className="mb-2 rounded-md border bg-background px-2 py-1 text-[11px] text-muted-foreground">
                <div className="whitespace-pre-wrap break-words">
                  {matchedPolicyDescription}
                </div>
              </div>
            ) : null}
            {rawOutputContent ? (
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
          ) : null}
        </div>
      </div>
    </div>
  );
}
