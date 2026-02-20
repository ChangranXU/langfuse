"use client";

import { useEffect, useMemo, useState } from "react";
import Header from "@/src/components/layouts/header";
import { Card, CardContent } from "@/src/components/ui/card";
import { Label } from "@/src/components/ui/label";
import { Switch } from "@/src/components/ui/switch";
import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { api } from "@/src/utils/api";
import { toast } from "sonner";
import {
  ErrorAnalysisModelSchema,
  type ErrorAnalysisModel,
} from "@/src/features/error-analysis/types";

function parseNullablePositiveInt(
  value: string,
): number | null | "invalid_format" | "invalid_range" {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return "invalid_format";

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) return "invalid_format";
  if (parsed < 1) return "invalid_range";
  return parsed;
}

function normalizeOptionalPath(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
}

export function ErrorAnalysisSettings(props: { projectId: string }) {
  const { projectId } = props;
  const utils = api.useUtils();
  const hasAccess = useHasProjectAccess({
    projectId,
    scope: "project:update",
  });

  const models = useMemo<ErrorAnalysisModel[]>(
    () => [...ErrorAnalysisModelSchema.options] as ErrorAnalysisModel[],
    [],
  );
  const [enabled, setEnabled] = useState(false);
  const [model, setModel] = useState<ErrorAnalysisModel>(models[0]!);
  const [minNewErrorNodesInput, setMinNewErrorNodesInput] = useState("");
  const [summaryMarkdownPathInput, setSummaryMarkdownPathInput] = useState("");

  const settingsQuery = api.projects.getErrorAnalysisSettings.useQuery(
    { projectId },
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
    },
  );

  useEffect(() => {
    if (!settingsQuery.data) return;
    setEnabled(settingsQuery.data.enabled);
    setModel(settingsQuery.data.model);
    setMinNewErrorNodesInput(
      settingsQuery.data.minNewErrorNodesForSummary == null
        ? ""
        : String(settingsQuery.data.minNewErrorNodesForSummary),
    );
    setSummaryMarkdownPathInput(
      settingsQuery.data.summaryAppendMarkdownAbsolutePath ?? "",
    );
  }, [settingsQuery.data]);

  const saveMutation = api.projects.setErrorAnalysisSettings.useMutation({
    onSuccess: async (saved) => {
      setEnabled(saved.enabled);
      setModel(saved.model);
      setMinNewErrorNodesInput(
        saved.minNewErrorNodesForSummary == null
          ? ""
          : String(saved.minNewErrorNodesForSummary),
      );
      setSummaryMarkdownPathInput(
        saved.summaryAppendMarkdownAbsolutePath ?? "",
      );
      await utils.projects.getErrorAnalysisSettings.invalidate({ projectId });
      toast.success("Error analysis settings saved");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const parsedMinNewErrorNodes = parseNullablePositiveInt(
    minNewErrorNodesInput,
  );
  const normalizedSummaryMarkdownPath = normalizeOptionalPath(
    summaryMarkdownPathInput,
  );
  const summaryPathHasInvalidAbsoluteFormat = Boolean(
    normalizedSummaryMarkdownPath &&
      !isAbsolutePath(normalizedSummaryMarkdownPath),
  );
  const summaryPathHasInvalidExtension = Boolean(
    normalizedSummaryMarkdownPath &&
      !normalizedSummaryMarkdownPath.toLowerCase().endsWith(".md"),
  );
  const hasValidationErrors =
    parsedMinNewErrorNodes === "invalid_format" ||
    parsedMinNewErrorNodes === "invalid_range" ||
    summaryPathHasInvalidAbsoluteFormat ||
    summaryPathHasInvalidExtension;
  const hasInvalidMinNewErrorNodes =
    parsedMinNewErrorNodes === "invalid_format" ||
    parsedMinNewErrorNodes === "invalid_range";
  const minNewErrorNodesForSave: number | null = hasInvalidMinNewErrorNodes
    ? null
    : parsedMinNewErrorNodes;

  const hasUnsavedChanges =
    settingsQuery.data != null &&
    (enabled !== settingsQuery.data.enabled ||
      model !== settingsQuery.data.model ||
      (hasInvalidMinNewErrorNodes
        ? minNewErrorNodesInput.trim().length > 0
        : minNewErrorNodesForSave !==
          settingsQuery.data.minNewErrorNodesForSummary) ||
      normalizedSummaryMarkdownPath !==
        settingsQuery.data.summaryAppendMarkdownAbsolutePath);

  return (
    <div>
      <Header title="Error Analysis" />
      <Card className="mt-4">
        <CardContent className="space-y-6 p-6">
          <div>
            <h3 className="text-lg font-medium">Automatic Error Analysis</h3>
            <p className="text-sm text-muted-foreground">
              Automatically run LLM analysis when an observation is ingested
              with level ERROR or WARNING.
            </p>
          </div>

          {settingsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading settings...</p>
          ) : settingsQuery.error ? (
            <p className="text-sm text-destructive">
              {settingsQuery.error.message}
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <Label htmlFor="auto-error-analysis" className="text-base">
                    Auto-generate error analysis
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Run analysis automatically for newly ingested
                    errors/warnings.
                  </p>
                </div>
                <Switch
                  id="auto-error-analysis"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  disabled={!hasAccess || saveMutation.isPending}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="auto-error-analysis-model">Model</Label>
                <Select
                  value={model}
                  onValueChange={(value) => {
                    if (models.includes(value as ErrorAnalysisModel)) {
                      setModel(value as ErrorAnalysisModel);
                    }
                  }}
                  disabled={!enabled || !hasAccess || saveMutation.isPending}
                >
                  <SelectTrigger
                    id="auto-error-analysis-model"
                    className="max-w-[240px]"
                  >
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
                {!enabled ? (
                  <p className="text-xs text-muted-foreground">
                    Enable auto-generation to select a model.
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="auto-summary-threshold">
                  New error nodes before auto summary update
                </Label>
                <Input
                  id="auto-summary-threshold"
                  inputMode="numeric"
                  value={minNewErrorNodesInput}
                  onChange={(e) => setMinNewErrorNodesInput(e.target.value)}
                  placeholder="5 (default)"
                  disabled={!hasAccess || saveMutation.isPending}
                  className="max-w-[240px]"
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to use the default threshold: 5.
                </p>
                {parsedMinNewErrorNodes === "invalid_format" ? (
                  <p className="text-xs text-destructive">
                    Please enter a whole number or leave it empty.
                  </p>
                ) : null}
                {parsedMinNewErrorNodes === "invalid_range" ? (
                  <p className="text-xs text-destructive">
                    Threshold must be at least 1.
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="summary-md-path">
                  Append summary prevention note to markdown path (optional)
                </Label>
                <Input
                  id="summary-md-path"
                  value={summaryMarkdownPathInput}
                  onChange={(e) => setSummaryMarkdownPathInput(e.target.value)}
                  placeholder="/absolute/path/to/error-summary.md"
                  disabled={!hasAccess || saveMutation.isPending}
                />
                <p className="text-xs text-muted-foreground">
                  Use an absolute `.md` path. If the file does not exist, it
                  will be created automatically. The `# HINT` section is
                  replaced on each summary update with the latest complete
                  summary.
                </p>
                {summaryPathHasInvalidAbsoluteFormat ? (
                  <p className="text-xs text-destructive">
                    Path must be absolute.
                  </p>
                ) : null}
                {summaryPathHasInvalidExtension ? (
                  <p className="text-xs text-destructive">
                    Path must end with `.md`.
                  </p>
                ) : null}
              </div>

              <Button
                variant="secondary"
                size="sm"
                loading={saveMutation.isPending}
                disabled={
                  !hasAccess || !hasUnsavedChanges || hasValidationErrors
                }
                onClick={() => {
                  if (
                    parsedMinNewErrorNodes === "invalid_format" ||
                    parsedMinNewErrorNodes === "invalid_range"
                  ) {
                    toast.error(
                      "Invalid threshold. Enter a whole number or leave empty.",
                    );
                    return;
                  }
                  if (summaryPathHasInvalidAbsoluteFormat) {
                    toast.error("Summary markdown path must be absolute.");
                    return;
                  }
                  if (summaryPathHasInvalidExtension) {
                    toast.error("Summary markdown path must end with .md.");
                    return;
                  }

                  saveMutation.mutate({
                    projectId,
                    enabled,
                    model,
                    minNewErrorNodesForSummary: minNewErrorNodesForSave,
                    summaryAppendMarkdownAbsolutePath:
                      normalizedSummaryMarkdownPath,
                  });
                }}
              >
                Save
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
