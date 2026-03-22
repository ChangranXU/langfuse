import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import type { FilterState } from "@langfuse/shared";
import Page from "@/src/components/layouts/page";
import Header from "@/src/components/layouts/header";
import { api } from "@/src/utils/api";
import { toast } from "sonner";
import { cn } from "@/src/utils/tailwind";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { Button } from "@/src/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/card";
import { Switch } from "@/src/components/ui/switch";
import { Textarea } from "@/src/components/ui/textarea";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { CodeMirrorEditor } from "@/src/components/editor/CodeMirrorEditor";
import DiffViewer from "@/src/components/DiffViewer";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/src/components/ui/alert-dialog";

type PolicyRegistryEntry = {
  name: string;
  enabled: boolean;
  description: string;
};

type LoadedPolicyData = {
  configuredPath: string | null;
  resolvedPathInput: string;
  policyJsonPath: string;
  policyRegistryPath: string;
  policyJson: Record<string, unknown>;
  policyRegistryJson: PolicyRegistryEntry[];
  policyCards: Array<{
    name: string;
    description: string;
    enabled: boolean;
    settingSections: string[];
    settingsBySection: Record<string, unknown>;
  }>;
  policySectionMap: Record<string, string[]>;
};

type PendingProposal = {
  policyName: string;
  summary: string;
  proposedPolicyJson: Record<string, unknown>;
  proposedPolicyRegistryJson: PolicyRegistryEntry[];
};

type PolicyStatsRow = {
  policyName: string;
  totalCount: number;
  acceptedCount: number;
  rejectedCount: number;
  acceptedRate: number;
  rejectedRate: number;
};

type PendingUnsavedAction = {
  type: "route_change";
  url: string;
};

const UNSAVED_CHANGES_CONFIRMATION_MESSAGE =
  "You have unsaved changes. Leave without saving?";

function stableStringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function buildSectionDrafts(params: {
  policyRegistryJson: PolicyRegistryEntry[];
  policyJson: Record<string, unknown>;
  policySectionMap: Record<string, string[]>;
}) {
  const { policyRegistryJson, policyJson, policySectionMap } = params;
  return Object.fromEntries(
    policyRegistryJson.map((entry) => [
      entry.name,
      Object.fromEntries(
        (policySectionMap[entry.name] ?? []).map((section) => [
          section,
          stableStringify(policyJson[section] ?? null),
        ]),
      ),
    ]),
  ) as Record<string, Record<string, string>>;
}

function buildPolicySectionPreview(params: {
  policyJson: Record<string, unknown>;
  policyName: string;
  policySectionMap: Record<string, string[]>;
}) {
  const sections = params.policySectionMap[params.policyName] ?? [];
  return {
    sections,
    preview: Object.fromEntries(
      sections.map((section) => [section, params.policyJson[section] ?? null]),
    ) as Record<string, unknown>,
  };
}

export default function PolicyGovernancePage() {
  const router = useRouter();
  const projectId = router.query.projectId as string | undefined;
  const utils = api.useUtils();
  const [pathInput, setPathInput] = useState("");
  const [isPathInputHydrated, setIsPathInputHydrated] = useState(false);
  const [loaded, setLoaded] = useState<LoadedPolicyData | null>(null);
  const [policyJsonDraft, setPolicyJsonDraft] = useState<
    Record<string, unknown>
  >({});
  const [policyRegistryDraft, setPolicyRegistryDraft] = useState<
    PolicyRegistryEntry[]
  >([]);
  const [sectionDrafts, setSectionDrafts] = useState<
    Record<string, Record<string, string>>
  >({});
  const [sectionErrors, setSectionErrors] = useState<
    Record<string, Record<string, string | null>>
  >({});
  const [pendingProposal, setPendingProposal] =
    useState<PendingProposal | null>(null);
  const [proposalBasePolicyJson, setProposalBasePolicyJson] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [proposalPolicyNameLoading, setProposalPolicyNameLoading] = useState<
    string | null
  >(null);
  const [pendingUnsavedAction, setPendingUnsavedAction] =
    useState<PendingUnsavedAction | null>(null);
  const [isUnsavedPromptOpen, setIsUnsavedPromptOpen] = useState(false);
  const [isUnsavedPromptBusy, setIsUnsavedPromptBusy] = useState(false);
  const allowNextRouteChangeRef = useRef(false);
  const autoLoadedPathRef = useRef<string | null>(null);
  const hasUpdateAccess = useHasProjectAccess({
    projectId: projectId ?? "",
    scope: "project:update",
  });
  const statsTimeRange = useMemo(() => {
    const toTimestamp = new Date();
    const fromTimestamp = new Date(
      toTimestamp.getTime() - 30 * 24 * 60 * 60 * 1000,
    );
    return { fromTimestamp, toTimestamp };
  }, []);

  const policySettingsQuery = api.projects.getPolicyGovernanceSettings.useQuery(
    { projectId: projectId ?? "" },
    {
      enabled: Boolean(projectId),
      refetchOnWindowFocus: false,
    },
  );
  const errorAnalysisSettingsQuery =
    api.projects.getErrorAnalysisSettings.useQuery(
      { projectId: projectId ?? "" },
      {
        enabled: Boolean(projectId),
        refetchOnWindowFocus: false,
      },
    );
  const policyConfirmationStatsQuery =
    api.dashboard.policyConfirmationStats.useQuery(
      {
        projectId: projectId ?? "",
        globalFilterState: [] as FilterState,
        fromTimestamp: statsTimeRange.fromTimestamp,
        toTimestamp: statsTimeRange.toTimestamp,
        version: "v1",
      },
      {
        enabled: Boolean(projectId),
        trpc: {
          context: {
            skipBatch: true,
          },
        },
      },
    );

  useEffect(() => {
    if (!policySettingsQuery.data) return;

    setPathInput(policySettingsQuery.data.kernelPolicyPathAbsolute ?? "");
    setIsPathInputHydrated(true);
  }, [policySettingsQuery.data]);

  const savePolicySettingsMutation =
    api.projects.setPolicyGovernanceSettings.useMutation({
      onSuccess: async (saved) => {
        setPathInput(saved.kernelPolicyPathAbsolute ?? "");
        if (projectId && saved.kernelPolicyPathAbsolute) {
          const savedPath = saved.kernelPolicyPathAbsolute.trim();
          if (savedPath.length > 0) {
            autoLoadedPathRef.current = savedPath;
            loadPolicyFilesMutation.mutate({
              projectId,
              pathOverride: savedPath,
            });
          }
        }
        await utils.projects.getPolicyGovernanceSettings.invalidate({
          projectId: projectId ?? "",
        });
        toast.success("Policy path saved");
      },
      onError: (error) => toast.error(error.message),
    });

  const loadPolicyFilesMutation =
    api.policyGovernance.loadPolicyFiles.useMutation({
      onSuccess: (data) => {
        const nextLoaded = data as LoadedPolicyData;
        setLoaded(nextLoaded);
        setPolicyJsonDraft(nextLoaded.policyJson);
        setPolicyRegistryDraft(nextLoaded.policyRegistryJson);
        setSectionDrafts(
          buildSectionDrafts({
            policyRegistryJson: nextLoaded.policyRegistryJson,
            policyJson: nextLoaded.policyJson,
            policySectionMap: nextLoaded.policySectionMap,
          }),
        );
        setSectionErrors({});
      },
      onError: (error) => toast.error(error.message),
    });
  const loadPolicyFiles = loadPolicyFilesMutation.mutate;
  const isLoadPolicyFilesPending = loadPolicyFilesMutation.isPending;

  const savePolicyFilesMutation =
    api.policyGovernance.savePolicyFiles.useMutation({
      onSuccess: async (data) => {
        const nextLoaded = data as LoadedPolicyData;
        setLoaded(nextLoaded);
        setPolicyJsonDraft(nextLoaded.policyJson);
        setPolicyRegistryDraft(nextLoaded.policyRegistryJson);
        setSectionDrafts(
          buildSectionDrafts({
            policyRegistryJson: nextLoaded.policyRegistryJson,
            policyJson: nextLoaded.policyJson,
            policySectionMap: nextLoaded.policySectionMap,
          }),
        );
        setSectionErrors({});
        await utils.policyGovernance.loadPolicyFiles.invalidate();
        toast.success("Policy files saved");
      },
      onError: (error) => toast.error(error.message),
    });

  useEffect(() => {
    if (!projectId) return;
    if (!isPathInputHydrated) return;
    const savedPath =
      policySettingsQuery.data?.kernelPolicyPathAbsolute?.trim() ?? "";
    if (!savedPath) return;
    if (autoLoadedPathRef.current === savedPath) return;
    if (isLoadPolicyFilesPending) return;

    autoLoadedPathRef.current = savedPath;
    loadPolicyFiles({
      projectId,
      pathOverride: savedPath,
    });
  }, [
    isPathInputHydrated,
    isLoadPolicyFilesPending,
    loadPolicyFiles,
    policySettingsQuery.data?.kernelPolicyPathAbsolute,
    projectId,
  ]);

  const suggestionMutation = api.policySuggestions.generate.useMutation();
  const proposalMutation =
    api.policyGovernance.generatePolicyUpdateProposal.useMutation();

  const hasSectionErrors = useMemo(
    () =>
      Object.values(sectionErrors).some((policyErrors) =>
        Object.values(policyErrors).some((error) => Boolean(error)),
      ),
    [sectionErrors],
  );

  const sectionMap = loaded?.policySectionMap ?? {};
  const highlightThresholdPct =
    errorAnalysisSettingsQuery.data?.policyRejectHighlightThresholdPct ?? 70;
  const policyStatsMap = useMemo(
    () =>
      new Map(
        (
          ((policyConfirmationStatsQuery.data as
            | PolicyStatsRow[]
            | undefined) ?? []) as PolicyStatsRow[]
        ).map((row) => [row.policyName, row]),
      ),
    [policyConfirmationStatsQuery.data],
  );
  const canSaveDraft =
    Boolean(loaded) &&
    hasUpdateAccess &&
    !hasSectionErrors &&
    !savePolicyFilesMutation.isPending;
  const hasUnsavedDraftChanges = useMemo(() => {
    if (!loaded) return false;
    return (
      stableStringify(policyJsonDraft) !== stableStringify(loaded.policyJson) ||
      stableStringify(policyRegistryDraft) !==
        stableStringify(loaded.policyRegistryJson)
    );
  }, [loaded, policyJsonDraft, policyRegistryDraft]);
  const hasUnsavedPathChanges =
    isPathInputHydrated &&
    pathInput.trim() !==
      (policySettingsQuery.data?.kernelPolicyPathAbsolute ?? "").trim();
  const hasUnsavedChanges = hasUnsavedDraftChanges || hasUnsavedPathChanges;

  const loadPathHint =
    "/absolute/path/to/ArbiterOS-Kernel/arbiteros_kernel (or direct /policy.json)";

  const onLoadPolicyFiles = () => {
    if (!projectId) return;
    const trimmed = pathInput.trim();
    loadPolicyFilesMutation.mutate({
      projectId,
      pathOverride: trimmed.length > 0 ? trimmed : undefined,
    });
  };

  const onSavePolicyFiles = () => {
    if (!projectId || !loaded) return;
    const trimmed = pathInput.trim();
    savePolicyFilesMutation.mutate({
      projectId,
      pathOverride: trimmed.length > 0 ? trimmed : undefined,
      policyJson: policyJsonDraft,
      policyRegistryJson: policyRegistryDraft,
    });
  };

  const promptForUnsavedChanges = useCallback(
    (action: PendingUnsavedAction) => {
      setPendingUnsavedAction(action);
      setIsUnsavedPromptOpen(true);
    },
    [],
  );

  const executePendingUnsavedAction = useCallback(
    (action: PendingUnsavedAction) => {
      if (action.type === "route_change") {
        allowNextRouteChangeRef.current = true;
        void router.push(action.url).catch(() => {
          allowNextRouteChangeRef.current = false;
        });
      }
    },
    [router],
  );

  const updateRegistryEntry = (
    policyName: string,
    updater: (entry: PolicyRegistryEntry) => PolicyRegistryEntry,
  ) => {
    setPolicyRegistryDraft((prev) =>
      prev.map((entry) => (entry.name === policyName ? updater(entry) : entry)),
    );
  };

  const updateSectionDraft = (params: {
    policyName: string;
    section: string;
    value: string;
  }) => {
    setSectionDrafts((prev) => ({
      ...prev,
      [params.policyName]: {
        ...(prev[params.policyName] ?? {}),
        [params.section]: params.value,
      },
    }));

    try {
      const parsed = JSON.parse(params.value);
      setPolicyJsonDraft((prev) => ({
        ...prev,
        [params.section]: parsed,
      }));
      setSectionErrors((prev) => ({
        ...prev,
        [params.policyName]: {
          ...(prev[params.policyName] ?? {}),
          [params.section]: null,
        },
      }));
    } catch (error) {
      setSectionErrors((prev) => ({
        ...prev,
        [params.policyName]: {
          ...(prev[params.policyName] ?? {}),
          [params.section]:
            error instanceof Error ? error.message : "Invalid JSON",
        },
      }));
    }
  };

  const onGenerateProposal = async (policyName: string) => {
    if (!projectId || !loaded) return;
    if (hasSectionErrors) {
      toast.error(
        "Fix invalid JSON section drafts before generating a proposal.",
      );
      return;
    }

    setProposalPolicyNameLoading(policyName);
    try {
      const now = new Date();
      const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const suggestion = await suggestionMutation.mutateAsync({
        projectId,
        policyName,
        globalFilterState: [] as FilterState,
        fromTimestamp: from,
        toTimestamp: now,
        version: "v1",
      });
      const proposal = await proposalMutation.mutateAsync({
        projectId,
        policyName,
        policyJson: policyJsonDraft,
        policyRegistryJson: policyRegistryDraft,
        suggestion: suggestion.suggestion,
      });
      setProposalBasePolicyJson(policyJsonDraft);
      setPendingProposal({
        policyName: proposal.policyName,
        summary: proposal.summary,
        proposedPolicyJson: proposal.proposedPolicyJson,
        proposedPolicyRegistryJson: proposal.proposedPolicyRegistryJson,
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to generate proposal",
      );
    } finally {
      setProposalPolicyNameLoading(null);
    }
  };

  const applyProposalToDraft = () => {
    if (!pendingProposal || !loaded) return;
    const nextRegistry = pendingProposal.proposedPolicyRegistryJson;
    const nextPolicy = pendingProposal.proposedPolicyJson;
    setPolicyRegistryDraft(nextRegistry);
    setPolicyJsonDraft(nextPolicy);
    setSectionDrafts(
      buildSectionDrafts({
        policyRegistryJson: nextRegistry,
        policyJson: nextPolicy,
        policySectionMap: loaded.policySectionMap,
      }),
    );
    setSectionErrors({});
    setPendingProposal(null);
    setProposalBasePolicyJson(null);
    toast.success(
      "LLM proposal applied to draft. Review and save to write files.",
    );
  };

  const proposalDiffPreview = useMemo(() => {
    if (!pendingProposal || !proposalBasePolicyJson || !loaded) return null;

    const currentPreview = buildPolicySectionPreview({
      policyJson: proposalBasePolicyJson,
      policyName: pendingProposal.policyName,
      policySectionMap: loaded.policySectionMap,
    });
    const proposedPreview = buildPolicySectionPreview({
      policyJson: pendingProposal.proposedPolicyJson,
      policyName: pendingProposal.policyName,
      policySectionMap: loaded.policySectionMap,
    });

    return {
      sections: currentPreview.sections,
      currentPolicyJson: currentPreview.preview,
      proposedPolicyJson: proposedPreview.preview,
    };
  }, [loaded, pendingProposal, proposalBasePolicyJson]);
  const proposalHasChanges = useMemo(() => {
    if (!proposalDiffPreview) return false;

    return (
      stableStringify(proposalDiffPreview.currentPolicyJson) !==
      stableStringify(proposalDiffPreview.proposedPolicyJson)
    );
  }, [proposalDiffPreview]);

  const handleUnsavedSaveAndContinue = useCallback(async () => {
    if (!pendingUnsavedAction) return;
    setIsUnsavedPromptBusy(true);
    try {
      if (hasUnsavedPathChanges && projectId) {
        await savePolicySettingsMutation.mutateAsync({
          projectId,
          kernelPolicyPathAbsolute:
            pathInput.trim().length > 0 ? pathInput.trim() : null,
        });
      }

      if (hasUnsavedDraftChanges) {
        if (hasSectionErrors) {
          toast.error("Please fix invalid JSON sections before saving.");
          setIsUnsavedPromptBusy(false);
          return;
        }
        if (!projectId || !loaded) {
          setIsUnsavedPromptBusy(false);
          return;
        }
        await savePolicyFilesMutation.mutateAsync({
          projectId,
          pathOverride:
            pathInput.trim().length > 0 ? pathInput.trim() : undefined,
          policyJson: policyJsonDraft,
          policyRegistryJson: policyRegistryDraft,
        });
      }
    } catch {
      setIsUnsavedPromptBusy(false);
      return;
    }

    const action = pendingUnsavedAction;
    setPendingUnsavedAction(null);
    setIsUnsavedPromptOpen(false);
    setIsUnsavedPromptBusy(false);
    executePendingUnsavedAction(action);
  }, [
    pendingUnsavedAction,
    hasUnsavedPathChanges,
    projectId,
    savePolicySettingsMutation,
    pathInput,
    hasUnsavedDraftChanges,
    hasSectionErrors,
    loaded,
    savePolicyFilesMutation,
    policyJsonDraft,
    policyRegistryDraft,
    executePendingUnsavedAction,
  ]);

  const handleUnsavedDiscardAndContinue = useCallback(() => {
    if (!pendingUnsavedAction) return;
    setIsUnsavedPromptBusy(true);
    const action = pendingUnsavedAction;
    setPendingUnsavedAction(null);
    setIsUnsavedPromptOpen(false);
    setIsUnsavedPromptBusy(false);
    executePendingUnsavedAction(action);
  }, [executePendingUnsavedAction, pendingUnsavedAction]);

  const handleUnsavedCancel = useCallback(() => {
    setPendingUnsavedAction(null);
    setIsUnsavedPromptOpen(false);
    setIsUnsavedPromptBusy(false);
  }, []);

  useEffect(() => {
    if (!hasUnsavedChanges) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    const handleRouteChangeStart = (url: string) => {
      if (allowNextRouteChangeRef.current) {
        allowNextRouteChangeRef.current = false;
        return;
      }

      promptForUnsavedChanges({ type: "route_change", url });
      const cancellationError = new Error(
        "Route change aborted due to unsaved changes.",
      ) as Error & { cancelled?: boolean };
      cancellationError.cancelled = true;
      router.events.emit("routeChangeError", cancellationError, url, {
        shallow: false,
      });
      throw cancellationError;
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    router.events.on("routeChangeStart", handleRouteChangeStart);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      router.events.off("routeChangeStart", handleRouteChangeStart);
    };
  }, [hasUnsavedChanges, promptForUnsavedChanges, router.events]);

  return (
    <Page
      headerProps={{
        title: "Policy",
      }}
      scrollable
    >
      <div className="space-y-4 p-3">
        <Card>
          <CardHeader>
            <CardTitle>Kernel Policy Path</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="kernel-policy-path">Path</Label>
              <Input
                id="kernel-policy-path"
                placeholder={loadPathHint}
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                disabled={
                  !hasUpdateAccess || savePolicySettingsMutation.isPending
                }
              />
              <p className="text-xs text-muted-foreground">
                Hint: set the `arbiteros_kernel` folder path (or direct path to
                `policy.json` / `policy_registry.json`).
              </p>
              {policySettingsQuery.data?.kernelPolicyPathAbsolute ? (
                <p className="text-xs text-muted-foreground">
                  Saved path detected. Policy files auto-load from this path on
                  page open.
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => {
                  if (!projectId) return;
                  savePolicySettingsMutation.mutate({
                    projectId,
                    kernelPolicyPathAbsolute:
                      pathInput.trim().length > 0 ? pathInput.trim() : null,
                  });
                }}
                disabled={
                  !hasUpdateAccess || savePolicySettingsMutation.isPending
                }
              >
                Save Path
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={onLoadPolicyFiles}
                disabled={!projectId || isLoadPolicyFilesPending}
              >
                {isLoadPolicyFilesPending ? "Loading..." : "Load Policy Files"}
              </Button>
            </div>
            {loaded ? (
              <div className="rounded border bg-muted/30 p-2 text-xs text-muted-foreground">
                <div>Resolved input: {loaded.resolvedPathInput}</div>
                <div>policy.json: {loaded.policyJsonPath}</div>
                <div>policy_registry.json: {loaded.policyRegistryPath}</div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {loaded ? (
          <Card>
            <CardHeader>
              <CardTitle>Policy Editor</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {policyRegistryDraft.map((entry) => {
                const sections = sectionMap[entry.name] ?? [];
                const stats = policyStatsMap.get(entry.name);
                const shouldHighlightByStats =
                  (stats?.rejectedRate ?? 0) * 100 >= highlightThresholdPct;
                return (
                  <div
                    key={entry.name}
                    className={cn(
                      "space-y-3 rounded border p-3",
                      shouldHighlightByStats &&
                        "border-destructive/50 bg-destructive/5",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Header title={entry.name} />
                      {shouldHighlightByStats ? (
                        <div className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
                          Highlighted by confirmation stats (
                          {Math.round((stats?.rejectedRate ?? 0) * 100)}%
                          rejected / threshold {highlightThresholdPct}%)
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center justify-between rounded border bg-muted/30 px-3 py-2">
                      <div>
                        <p className="text-sm font-medium">Enabled</p>
                        <p className="text-xs text-muted-foreground">
                          Toggle policy activation in `policy_registry.json`.
                        </p>
                      </div>
                      <Switch
                        checked={entry.enabled}
                        disabled={!hasUpdateAccess}
                        onCheckedChange={(checked) =>
                          updateRegistryEntry(entry.name, (prev) => ({
                            ...prev,
                            enabled: checked,
                          }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Description</Label>
                      <Textarea
                        value={entry.description}
                        disabled={!hasUpdateAccess}
                        onChange={(e) =>
                          updateRegistryEntry(entry.name, (prev) => ({
                            ...prev,
                            description: e.target.value,
                          }))
                        }
                      />
                    </div>
                    {sections.length > 0 ? (
                      <div className="space-y-3">
                        {sections.map((section) => {
                          const value =
                            sectionDrafts[entry.name]?.[section] ??
                            stableStringify(policyJsonDraft[section] ?? null);
                          const error =
                            sectionErrors[entry.name]?.[section] ?? null;
                          return (
                            <div
                              key={`${entry.name}-${section}`}
                              className="space-y-2"
                            >
                              <Label>{section}</Label>
                              <CodeMirrorEditor
                                mode="json"
                                value={value}
                                editable={hasUpdateAccess}
                                lineNumbers
                                minHeight={120}
                                maxHeight={360}
                                onChange={(next) =>
                                  updateSectionDraft({
                                    policyName: entry.name,
                                    section,
                                    value: next,
                                  })
                                }
                              />
                              {error ? (
                                <p className="text-xs text-destructive">
                                  Invalid JSON: {error}
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No dedicated runtime settings mapped for this policy.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void onGenerateProposal(entry.name)}
                        disabled={
                          !hasUpdateAccess ||
                          proposalPolicyNameLoading === entry.name ||
                          hasSectionErrors
                        }
                      >
                        {proposalPolicyNameLoading === entry.name
                          ? "Generating..."
                          : "LLM Suggest Update"}
                      </Button>
                    </div>
                  </div>
                );
              })}
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  onClick={onSavePolicyFiles}
                  disabled={!canSaveDraft}
                >
                  {savePolicyFilesMutation.isPending
                    ? "Saving..."
                    : "Save Policy Files"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <AlertDialog
        open={Boolean(pendingProposal)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingProposal(null);
            setProposalBasePolicyJson(null);
          }
        }}
      >
        <AlertDialogContent className="max-w-6xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              LLM Policy Update Proposal: {pendingProposal?.policyName}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingProposal?.summary}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {proposalDiffPreview && proposalHasChanges ? (
            <div className="max-h-[70vh] space-y-3 overflow-y-auto">
              <p className="text-sm text-muted-foreground">
                Showing only the `policy.json` sections for{" "}
                {pendingProposal?.policyName}
                {proposalDiffPreview.sections.length > 0
                  ? `: ${proposalDiffPreview.sections.join(", ")}`
                  : "."}
              </p>
              <DiffViewer
                oldLabel="policy.json (current)"
                newLabel="policy.json (proposal)"
                oldSubLabel={pendingProposal?.policyName}
                newSubLabel={pendingProposal?.policyName}
                oldString={stableStringify(
                  proposalDiffPreview.currentPolicyJson,
                )}
                newString={stableStringify(
                  proposalDiffPreview.proposedPolicyJson,
                )}
              />
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>
              {proposalHasChanges ? "Reject" : "Cancel"}
            </AlertDialogCancel>
            {proposalHasChanges ? (
              <Button type="button" onClick={applyProposalToDraft}>
                Apply to Draft
              </Button>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={isUnsavedPromptOpen}
        onOpenChange={(open) => {
          if (!open) {
            handleUnsavedCancel();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              {UNSAVED_CHANGES_CONFIRMATION_MESSAGE}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={handleUnsavedCancel}
              disabled={isUnsavedPromptBusy}
            >
              Stay
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={handleUnsavedDiscardAndContinue}
              disabled={isUnsavedPromptBusy}
            >
              Discard and leave
            </Button>
            <Button
              type="button"
              onClick={() => void handleUnsavedSaveAndContinue()}
              disabled={isUnsavedPromptBusy}
            >
              Save and leave
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
