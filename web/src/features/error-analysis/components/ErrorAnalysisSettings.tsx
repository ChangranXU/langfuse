"use client";

import { useEffect, useMemo, useState } from "react";
import Header from "@/src/components/layouts/header";
import { Card, CardContent } from "@/src/components/ui/card";
import { Label } from "@/src/components/ui/label";
import { Switch } from "@/src/components/ui/switch";
import { Button } from "@/src/components/ui/button";
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
  }, [settingsQuery.data]);

  const saveMutation = api.projects.setErrorAnalysisSettings.useMutation({
    onSuccess: async (saved) => {
      setEnabled(saved.enabled);
      setModel(saved.model);
      await utils.projects.getErrorAnalysisSettings.invalidate({ projectId });
      toast.success("Error analysis settings saved");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const hasUnsavedChanges =
    settingsQuery.data != null &&
    (enabled !== settingsQuery.data.enabled ||
      model !== settingsQuery.data.model);

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

              <Button
                variant="secondary"
                size="sm"
                loading={saveMutation.isPending}
                disabled={!hasAccess || !hasUnsavedChanges}
                onClick={() => {
                  saveMutation.mutate({
                    projectId,
                    enabled,
                    model,
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
