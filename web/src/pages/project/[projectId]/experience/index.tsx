import { useMemo, useState } from "react";
import { useRouter } from "next/router";
import Page from "@/src/components/layouts/page";
import { Button } from "@/src/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/src/components/ui/tabs";
import { CodeView, JSONView } from "@/src/components/ui/CodeJsonViewer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/src/components/ui/select";
import { api } from "@/src/utils/api";
import { copyTextToClipboard } from "@/src/utils/clipboard";
import { toast } from "sonner";
import {
  ExperienceSummaryModelSchema,
  type ExperienceSummaryModel,
} from "@/src/features/experience-summary/types";
import { ExperienceSummaryView } from "@/src/features/experience-summary/components/ExperienceSummaryView";
import { buildExperienceCopyAllText } from "@/src/features/experience-summary/utils";

function downloadJson(params: { data: unknown; filename: string }) {
  const blob = new Blob([JSON.stringify(params.data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = params.filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ExperienceSummaryPage() {
  const router = useRouter();
  const utils = api.useUtils();
  const projectId = router.query.projectId as string | undefined;

  const models = useMemo<ExperienceSummaryModel[]>(
    () => [...ExperienceSummaryModelSchema.options] as ExperienceSummaryModel[],
    [],
  );
  const [model, setModel] = useState<ExperienceSummaryModel>(models[0]!);
  const [view, setView] = useState<"formatted" | "json" | "raw">("formatted");

  const getQuery = api.experienceSummary.get.useQuery(
    { projectId: projectId ?? "" },
    { enabled: Boolean(projectId), refetchOnWindowFocus: false },
  );

  const incrementalStatusQuery =
    api.experienceSummary.getIncrementalUpdateStatus.useQuery(
      { projectId: projectId ?? "" },
      {
        enabled: Boolean(projectId),
        refetchOnWindowFocus: true,
      },
    );

  const generate = api.experienceSummary.generate.useMutation({
    onSuccess: async () => {
      toast.success("Experience summary updated");
      await Promise.allSettled([
        utils.experienceSummary.get.invalidate({
          projectId: projectId ?? "",
        }),
        utils.experienceSummary.getIncrementalUpdateStatus.invalidate({
          projectId: projectId ?? "",
        }),
        // Refresh any open error-analysis dropdown status widgets.
        utils.errorAnalysis.getSummaryUpdateStatus.invalidate(),
      ]);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const createPrompt = api.prompts.create.useMutation({
    onSuccess: () => {
      toast.success("Saved prompt");
      void utils.prompts.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const row = getQuery.data;
  const summary = row?.summary ?? null;

  const canAct = Boolean(projectId) && !generate.isPending;
  const isIncrementalUpToDate =
    incrementalStatusQuery.data?.pendingAnalysesCount === 0;

  return (
    <Page
      headerProps={{
        title: "Experience",
      }}
      scrollable
      withPadding
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={model}
              onValueChange={(v) => {
                if (models.includes(v as ExperienceSummaryModel)) {
                  setModel(v as ExperienceSummaryModel);
                }
              }}
            >
              <SelectTrigger className="h-8 w-[180px]">
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

            <Button
              variant="secondary"
              size="sm"
              loading={generate.isPending}
              disabled={!canAct}
              onClick={() => {
                if (!projectId) return;
                generate.mutate({
                  projectId,
                  mode: "full",
                  model,
                  maxItems: 50,
                });
              }}
            >
              Generate (full)
            </Button>
            <Button
              variant="outline"
              size="sm"
              loading={generate.isPending}
              disabled={!canAct || isIncrementalUpToDate}
              onClick={() => {
                if (!projectId) return;
                generate.mutate({
                  projectId,
                  mode: "incremental",
                  model,
                  maxItems: 50,
                });
              }}
            >
              Update (incremental)
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!summary}
              onClick={async () => {
                if (!summary) return;
                await copyTextToClipboard(buildExperienceCopyAllText(summary));
                toast.success("Copied all prompt lines");
              }}
            >
              Copy all
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!summary || createPrompt.isPending}
              loading={createPrompt.isPending}
              onClick={() => {
                if (!summary || !projectId) return;
                createPrompt.mutate({
                  projectId,
                  name: summary.promptPack.title,
                  type: "text",
                  prompt: buildExperienceCopyAllText(summary),
                  config: {},
                  labels: [],
                  tags: ["experience-summary"],
                  commitMessage: "Save auto-generated experience prompt lines",
                });
              }}
            >
              Save prompt
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!summary}
              onClick={() => {
                if (!summary || !projectId) return;
                downloadJson({
                  data: summary,
                  filename: `experience-summary-${projectId}.json`,
                });
                toast.success("Downloaded JSON");
              }}
            >
              Download JSON
            </Button>
          </div>
        </div>

        {getQuery.isLoading ? (
          <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : getQuery.error ? (
          <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
            {getQuery.error.message}
          </div>
        ) : summary ? (
          <div className="rounded-md border bg-background p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium">Summary</div>
              <Tabs value={view} onValueChange={(v) => setView(v as any)}>
                <TabsList className="h-fit p-0.5">
                  <TabsTrigger value="formatted" className="h-fit px-1 text-xs">
                    Formatted
                  </TabsTrigger>
                  <TabsTrigger value="json" className="h-fit px-1 text-xs">
                    JSON
                  </TabsTrigger>
                  <TabsTrigger value="raw" className="h-fit px-1 text-xs">
                    Raw JSON
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <div className="mt-3">
              {view === "formatted" ? (
                <ExperienceSummaryView summary={summary} />
              ) : view === "json" ? (
                <JSONView json={summary} hideTitle scrollable borderless />
              ) : (
                <CodeView
                  content={JSON.stringify(summary, null, 2)}
                  scrollable
                />
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
            No experience summary yet. Run Analyze on some ERROR/WARNING
            observations to create ErrorAnalysis records, then click Generate.
          </div>
        )}
      </div>
    </Page>
  );
}
