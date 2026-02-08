"use client";

import { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/src/components/ui/button";
import { JSONView } from "@/src/components/ui/CodeJsonViewer";
import { Tabs, TabsList, TabsTrigger } from "@/src/components/ui/tabs";
import { Badge } from "@/src/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { api } from "@/src/utils/api";
import {
  type ErrorAnalysisAnalyzeOutput,
  type ErrorAnalysisModel,
  ErrorAnalysisModelSchema,
} from "../types";

function FormattedAnalysisView(props: {
  rendered: ErrorAnalysisAnalyzeOutput["rendered"];
}) {
  const { rendered } = props;

  return (
    <div className="flex flex-col gap-3 text-xs">
      {/* issue */}
      <div className="flex flex-col gap-1">
        <div className="font-mono font-medium text-muted-foreground">issue</div>
        <div className="whitespace-pre-wrap break-words rounded-md border bg-background p-2">
          {rendered.issue}
        </div>
      </div>

      {/* errorType */}
      <div className="flex flex-col gap-1">
        <div className="font-mono font-medium text-muted-foreground">
          errorType
        </div>
        {rendered.errorType ? (
          <div className="rounded-md border bg-background p-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="font-mono">
                {rendered.errorType}
              </Badge>
              {rendered.errorTypeConfidence != null ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {rendered.errorTypeConfidence.toFixed(2)}
                </span>
              ) : null}
              {rendered.errorTypeFromList != null ? (
                <span className="text-xs text-muted-foreground">
                  {rendered.errorTypeFromList ? "catalog" : "generated"}
                </span>
              ) : null}
            </div>
            {rendered.errorTypeDescription ? (
              <div className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">
                {rendered.errorTypeDescription}
              </div>
            ) : null}
            {rendered.errorTypeWhy ? (
              <div className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">
                {rendered.errorTypeWhy}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border bg-background p-2 text-muted-foreground">
            No error type classified yet. Click Analyze to generate one.
          </div>
        )}
      </div>

      {/* rootCause */}
      <div className="flex flex-col gap-1">
        <div className="font-mono font-medium text-muted-foreground">
          rootCause
        </div>
        <div className="whitespace-pre-wrap break-words rounded-md border bg-background p-2">
          {rendered.rootCause}
        </div>
      </div>

      {/* resolveNow */}
      <div className="flex flex-col gap-1">
        <div className="font-mono font-medium text-muted-foreground">
          resolveNow
        </div>
        <div className="flex flex-col gap-2">
          {rendered.resolveNow.length > 0 ? (
            rendered.resolveNow.map((item, idx) => {
              const effectiveSubtitle = `${idx + 1}`;
              const content = item.trim();

              return (
                <div
                  key={`${idx}-${effectiveSubtitle}`}
                  className="rounded-md border bg-background p-2"
                >
                  <div className="text-xs font-medium">{effectiveSubtitle}</div>
                  <div className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                    {content}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="rounded-md border bg-background p-2 text-muted-foreground">
              No immediate resolution steps returned.
            </div>
          )}
        </div>
      </div>

      {/* preventionNextCall */}
      <div className="flex flex-col gap-1">
        <div className="font-mono font-medium text-muted-foreground">
          preventionNextCall
        </div>
        <div className="flex flex-col gap-2">
          {rendered.preventionNextCall.length > 0 ? (
            rendered.preventionNextCall.map((item, idx) => {
              const effectiveSubtitle = `${idx + 1}`;
              const content = item.trim();

              return (
                <div
                  key={`${idx}-${effectiveSubtitle}`}
                  className="rounded-md border bg-background p-2"
                >
                  <div className="text-xs font-medium">{effectiveSubtitle}</div>
                  <div className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                    {content}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="rounded-md border bg-background p-2 text-muted-foreground">
              No prevention steps returned.
            </div>
          )}
        </div>
      </div>

      {/* contextSufficient */}
      <div className="flex flex-col gap-1">
        <div className="font-mono font-medium text-muted-foreground">
          contextSufficient
        </div>
        <div className="rounded-md border bg-background p-2">
          <div className="font-mono text-xs">
            {rendered.contextSufficient ? "true" : "false"}
          </div>
        </div>
      </div>

      {/* confidence */}
      <div className="flex flex-col gap-1">
        <div className="font-mono font-medium text-muted-foreground">
          confidence
        </div>
        <div className="rounded-md border bg-background p-2">
          <div className="flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
              <div
                className="h-2 bg-primary"
                style={{
                  width: `${Math.max(0, Math.min(1, rendered.confidence)) * 100}%`,
                }}
              />
            </div>
            <div className="font-mono text-xs">
              {rendered.confidence.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* relevantObservations */}
      <div className="flex flex-col gap-1">
        <div className="font-mono font-medium text-muted-foreground">
          relevantObservations
        </div>
        <div className="flex flex-col gap-2">
          {rendered.relevantObservations.length > 0 ? (
            rendered.relevantObservations.map((obsId, idx) => (
              <div
                key={`${idx}-${obsId}`}
                className="rounded-md border bg-background p-2"
              >
                <div className="text-xs font-medium">{`#${idx + 1}`}</div>
                <div className="mt-1 whitespace-pre-wrap break-words font-mono text-muted-foreground">
                  {obsId}
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-md border bg-background p-2 text-muted-foreground">
              No relevant observations returned.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ErrorAnalysisDropdown(props: {
  projectId: string;
  traceId: string;
  observationId: string;
  level: "ERROR" | "WARNING";
}) {
  const models = useMemo<ErrorAnalysisModel[]>(
    () => [...ErrorAnalysisModelSchema.options] as ErrorAnalysisModel[],
    [],
  );
  const [model, setModel] = useState<ErrorAnalysisModel>(models[0]!);
  const [result, setResult] = useState<ErrorAnalysisAnalyzeOutput | null>(null);
  const [resultView, setResultView] = useState<"rendered" | "original">(
    "rendered",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data: savedAnalysis } = api.errorAnalysis.get.useQuery(
    {
      projectId: props.projectId,
      traceId: props.traceId,
      observationId: props.observationId,
    },
    {
      enabled: !result,
      refetchOnWindowFocus: false,
    },
  );

  useEffect(() => {
    if (savedAnalysis && !result) {
      setResult(savedAnalysis);
      setResultView("rendered");
    }
  }, [savedAnalysis, result]);

  const runAnalysis = (params?: { clearExisting?: boolean }) => {
    setErrorMessage(null);
    setResultView("rendered");
    if (params?.clearExisting ?? true) {
      setResult(null);
    }
    analyze.mutate({
      traceId: props.traceId,
      projectId: props.projectId,
      observationId: props.observationId,
      model,
      maxContextChars: 80_000,
      timestamp: null,
      fromTimestamp: null,
      verbosity: "full",
    });
  };

  const analyze = api.errorAnalysis.analyze.useMutation({
    onSuccess: (data) => {
      setResult(data);
      setResultView("rendered");
      setErrorMessage(null);
    },
    onError: (err) => {
      setResult(null);
      setErrorMessage(err.message);
    },
  });

  const settingsHref = `/project/${props.projectId}/settings/llm-connections`;
  const showSettingsHint =
    errorMessage?.toLowerCase().includes("llm connections") ||
    errorMessage?.toLowerCase().includes("openai api key") ||
    false;

  return (
    <div className="flex w-[420px] flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <div className="text-sm font-medium">LLM Debug Analysis</div>
          <div className="text-xs text-muted-foreground">
            Analyzes this {props.level.toLowerCase()} using trace context.
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Select
            value={model}
            onValueChange={(v) => {
              if (models.includes(v as ErrorAnalysisModel)) {
                setModel(v as ErrorAnalysisModel);
              }
            }}
          >
            <SelectTrigger className="h-8">
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={analyze.isPending}
          onClick={() => {
            runAnalysis({ clearExisting: true });
          }}
        >
          Analyze
        </Button>
        {result ? (
          <Button
            variant="outline"
            size="sm"
            loading={analyze.isPending}
            onClick={() => {
              runAnalysis({ clearExisting: false });
            }}
          >
            Regenerate
          </Button>
        ) : null}
      </div>

      {errorMessage ? (
        <div className="rounded-md border bg-background p-2 text-xs">
          <div className="font-medium text-destructive">Analysis failed</div>
          <div className="mt-1 whitespace-pre-wrap text-muted-foreground">
            {errorMessage}
          </div>
          {showSettingsHint ? (
            <div className="mt-2">
              <Link className="text-primary underline" href={settingsHref}>
                Go to Settings → LLM Connections
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div className="relative rounded-md border bg-background p-2">
          <div className="absolute right-2 top-2">
            <Tabs
              className="h-fit py-0.5"
              value={resultView}
              onValueChange={(value) =>
                setResultView(value as "rendered" | "original")
              }
            >
              <TabsList className="h-fit p-0.5">
                <TabsTrigger value="rendered" className="h-fit px-1 text-xs">
                  Formatted
                </TabsTrigger>
                <TabsTrigger value="original" className="h-fit px-1 text-xs">
                  JSON
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="pt-7">
            {resultView === "rendered" ? (
              <FormattedAnalysisView rendered={result.rendered} />
            ) : (
              <JSONView
                json={result.original}
                hideTitle
                scrollable
                borderless
              />
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-md border bg-background p-2 text-xs text-muted-foreground">
          Click Analyze to generate a structured root cause analysis.
        </div>
      )}
    </div>
  );
}
