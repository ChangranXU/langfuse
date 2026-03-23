import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { z as zodV3 } from "zod/v3";
import {
  ChatMessageRole,
  ChatMessageType,
  LLMAdapter,
  LLMApiKeySchema,
  type ChatMessage,
} from "@langfuse/shared";
import {
  fetchLLMCompletion,
  isLLMCompletionError,
  logger,
} from "@langfuse/shared/src/server";
import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import { throwIfNoProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { projectRoleAccessRights } from "@/src/features/rbac/constants/projectAccessRights";
import { resolveDemoOpenAIModel } from "@/src/features/error-analysis/types";
import { readFile, stat, writeFile } from "fs/promises";
import { basename, dirname, isAbsolute, join } from "path";

const PolicyRegistryEntrySchema = z.object({
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  description: z.string().default(""),
});
const PolicyRegistrySchema = z.array(PolicyRegistryEntrySchema);
const JsonObjectSchema = z.record(z.string(), z.unknown());

const PolicyGovernanceSettingsSchema = z.object({
  kernelPolicyPathAbsolute: z.string().trim().min(1).nullable().default(null),
  lastPolicyUpdatedAt: z.string().trim().min(1).nullable().default(null),
});

export const POLICY_SECTION_MAP: Record<string, string[]> = {
  PathBudgetPolicy: ["paths", "input_budget"],
  AllowDenyPolicy: ["allow", "deny"],
  EfsmGatePolicy: ["efsm"],
  TaintPolicy: ["taint"],
  RateLimitPolicy: ["rate_limit"],
  OutputBudgetPolicy: ["output_budget"],
  SecurityLabelPolicy: ["security"],
  ExecCompositePolicy: ["exec_composite_policy"],
  DeletePolicy: ["delete_policy"],
};

const PolicyCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  settingSections: z.array(z.string()),
  settingsBySection: z.record(z.string(), z.unknown()),
});

const LoadPolicyFilesOutputSchema = z.object({
  configuredPath: z.string().nullable(),
  resolvedPathInput: z.string(),
  policyJsonPath: z.string(),
  policyRegistryPath: z.string(),
  policyJson: JsonObjectSchema,
  policyRegistryJson: PolicyRegistrySchema,
  policyCards: z.array(PolicyCardSchema),
  policySectionMap: z.record(z.string(), z.array(z.string())),
});

const SavePolicyFilesInputSchema = z.object({
  projectId: z.string(),
  pathOverride: z.string().trim().min(1).optional(),
  policyJson: JsonObjectSchema,
  policyRegistryJson: PolicyRegistrySchema,
});

const GeneratePolicyUpdateProposalInputSchema = z.object({
  projectId: z.string(),
  policyName: z.string().trim().min(1),
  policyJson: JsonObjectSchema,
  policyRegistryJson: PolicyRegistrySchema,
  suggestion: z.object({
    suggestion: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    supportingSignals: z.array(z.string()).default([]),
  }),
});

const GeneratePolicyUpdateProposalOutputSchema = z.object({
  policyName: z.string(),
  summary: z.string(),
  appliedSections: z.array(z.string()),
  proposedPolicyJson: JsonObjectSchema,
  proposedPolicyRegistryJson: PolicyRegistrySchema,
});

const PolicyUpdateProposalResultSchema = z.object({
  summary: z.string().trim().min(1),
  proposedPolicyJson: JsonObjectSchema,
});

const PolicyUpdateProposalStructuredOutputSchema = zodV3.object({
  summary: zodV3
    .string()
    .describe(
      "1-2 concise lines describing the proposed policy change and why it helps.",
    ),
  proposedPolicyJson: zodV3
    .record(zodV3.any())
    .describe(
      "Complete updated policy.json object. Preserve unrelated sections exactly as provided.",
    ),
});
const POLICY_UPDATE_PROPOSAL_MAX_TOKENS = 3200;

function extractFirstJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (char === "}") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start !== -1) {
        return trimmed.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseJsonObjectFromCompletion(completion: string): unknown {
  const trimmed = completion.trim();
  const objectMatch = extractFirstJsonObject(trimmed);
  const candidates = [trimmed, objectMatch].filter((c): c is string =>
    Boolean(c),
  );

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error("Could not parse JSON object from LLM response.");
}

function unwrapProposalResult(rawResult: unknown): unknown {
  if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) {
    return rawResult;
  }

  const obj = rawResult as Record<string, unknown>;
  const nestedCandidate = [
    obj.proposal,
    obj.result,
    obj.output,
    obj.response,
  ].find(
    (value) => value && typeof value === "object" && !Array.isArray(value),
  );

  const source =
    (nestedCandidate as Record<string, unknown> | undefined) ??
    (rawResult as Record<string, unknown>);

  const summary = source.summary ?? source.reason ?? source.message;
  const rawPolicyJson = source.proposedPolicyJson ?? source.policyJson;

  const maybeParseJson = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  };

  const normalized: Record<string, unknown> = {
    ...(summary !== undefined ? { summary } : {}),
    ...(rawPolicyJson !== undefined
      ? { proposedPolicyJson: maybeParseJson(rawPolicyJson) }
      : {}),
  };

  return Object.keys(normalized).length > 0
    ? { ...source, ...normalized }
    : source;
}

function parsePolicyGovernanceSettings(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {
      kernelPolicyPathAbsolute: null as string | null,
      lastPolicyUpdatedAt: null as string | null,
    };
  }

  const maybe = (metadata as Record<string, unknown>).policyGovernance;
  const parsed = PolicyGovernanceSettingsSchema.safeParse(maybe);
  if (!parsed.success)
    return {
      kernelPolicyPathAbsolute: null as string | null,
      lastPolicyUpdatedAt: null as string | null,
    };
  return parsed.data;
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectoryPath(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function buildPolicyCards(params: {
  policyRegistryJson: z.infer<typeof PolicyRegistrySchema>;
  policyJson: z.infer<typeof JsonObjectSchema>;
}) {
  const { policyRegistryJson, policyJson } = params;
  return policyRegistryJson.map((entry) => {
    const settingSections = POLICY_SECTION_MAP[entry.name] ?? [];
    const settingsBySection = Object.fromEntries(
      settingSections.map((section) => [section, policyJson[section] ?? null]),
    );
    return {
      name: entry.name,
      description: entry.description ?? "",
      enabled: entry.enabled,
      settingSections,
      settingsBySection,
    };
  });
}

export async function resolvePolicyPaths(pathInput: string) {
  const trimmed = pathInput.trim();
  if (!trimmed) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Policy path is required.",
    });
  }
  if (!isAbsolute(trimmed)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Policy path must be absolute.",
    });
  }

  const candidates: Array<{
    policyJsonPath: string;
    policyRegistryPath: string;
  }> = [];

  const base = basename(trimmed);
  if (base === "policy.json") {
    candidates.push({
      policyJsonPath: trimmed,
      policyRegistryPath: join(dirname(trimmed), "policy_registry.json"),
    });
  } else if (base === "policy_registry.json") {
    candidates.push({
      policyJsonPath: join(dirname(trimmed), "policy.json"),
      policyRegistryPath: trimmed,
    });
  } else if (await isDirectoryPath(trimmed)) {
    candidates.push({
      policyJsonPath: join(trimmed, "policy.json"),
      policyRegistryPath: join(trimmed, "policy_registry.json"),
    });
    candidates.push({
      policyJsonPath: join(trimmed, "arbiteros_kernel", "policy.json"),
      policyRegistryPath: join(
        trimmed,
        "arbiteros_kernel",
        "policy_registry.json",
      ),
    });
  }

  for (const candidate of candidates) {
    const hasPolicy = await pathExists(candidate.policyJsonPath);
    const hasRegistry = await pathExists(candidate.policyRegistryPath);
    if (hasPolicy && hasRegistry) {
      return {
        resolvedPathInput: trimmed,
        policyJsonPath: candidate.policyJsonPath,
        policyRegistryPath: candidate.policyRegistryPath,
      };
    }
  }

  throw new TRPCError({
    code: "NOT_FOUND",
    message:
      "Could not resolve policy.json and policy_registry.json from the provided path. Provide either the arbiteros_kernel folder or a direct path to one of the files.",
  });
}

async function readPolicyDocuments(paths: {
  policyJsonPath: string;
  policyRegistryPath: string;
}) {
  let rawPolicy = "";
  let rawRegistry = "";
  try {
    rawPolicy = await readFile(paths.policyJsonPath, "utf8");
    rawRegistry = await readFile(paths.policyRegistryPath, "utf8");
  } catch (error) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Failed to read policy files: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  let parsedPolicy: unknown;
  let parsedRegistry: unknown;
  try {
    parsedPolicy = JSON.parse(rawPolicy);
    parsedRegistry = JSON.parse(rawRegistry);
  } catch (error) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Failed to parse policy JSON files: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const policyJson = JsonObjectSchema.safeParse(parsedPolicy);
  if (!policyJson.success) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "policy.json is not a valid JSON object.",
    });
  }

  const policyRegistryJson = PolicyRegistrySchema.safeParse(parsedRegistry);
  if (!policyRegistryJson.success) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "policy_registry.json is not a valid policy registry array.",
    });
  }

  return {
    policyJson: policyJson.data,
    policyRegistryJson: policyRegistryJson.data,
  };
}

function resolveErrorAnalysisModelFromMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "gpt-5.2" as const;
  }
  const autoErrorAnalysis = (metadata as Record<string, unknown>)
    .autoErrorAnalysis;
  if (
    !autoErrorAnalysis ||
    typeof autoErrorAnalysis !== "object" ||
    Array.isArray(autoErrorAnalysis)
  ) {
    return "gpt-5.2" as const;
  }
  const rawModel = (autoErrorAnalysis as Record<string, unknown>).model;
  return rawModel === "gpt-4.1" ? ("gpt-4.1" as const) : ("gpt-5.2" as const);
}

function mapLLMCompletionErrorToTRPCError(e: unknown): TRPCError | null {
  if (!isLLMCompletionError(e)) return null;
  const status = e.responseStatusCode ?? 500;
  const baseMessage = `LLM request failed (HTTP ${status}). ${e.message}`;

  if (status === 401 || status === 403) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        baseMessage +
        " Check Settings -> LLM Connections (API key / permissions / base URL).",
    });
  }
  if (status === 404) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        baseMessage +
        " The selected model may not exist on your configured endpoint.",
    });
  }
  if (status === 429) {
    return new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `${baseMessage} Please retry shortly.`,
    });
  }
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: baseMessage,
  });
}

export function parseProposalResult(rawResult: unknown) {
  const unwrappedDirect = unwrapProposalResult(rawResult);
  const direct = PolicyUpdateProposalResultSchema.safeParse(unwrappedDirect);
  if (direct.success) return direct.data;

  if (typeof rawResult === "string") {
    try {
      const parsed = parseJsonObjectFromCompletion(rawResult);
      return PolicyUpdateProposalResultSchema.parse(
        unwrapProposalResult(parsed),
      );
    } catch {
      // handled below
    }
  }

  logger.warn("Policy update proposal payload did not match schema", {
    rawResult:
      typeof rawResult === "string"
        ? rawResult.slice(0, 1500)
        : JSON.stringify(rawResult).slice(0, 1500),
    unwrappedResult:
      typeof unwrappedDirect === "string"
        ? unwrappedDirect.slice(0, 1500)
        : JSON.stringify(unwrappedDirect).slice(0, 1500),
  });

  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "LLM returned an invalid policy update proposal payload (schema mismatch).",
  });
}

export const policyGovernanceRouter = createTRPCRouter({
  loadPolicyFiles: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        pathOverride: z.string().trim().min(1).optional(),
      }),
    )
    .output(LoadPolicyFilesOutputSchema)
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "project:read",
      });

      const project = await ctx.prisma.project.findUnique({
        where: { id: input.projectId, orgId: ctx.session.orgId },
        select: { metadata: true },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      const existingSettings = parsePolicyGovernanceSettings(project.metadata);
      const configuredPath = existingSettings.kernelPolicyPathAbsolute;
      const selectedPath = input.pathOverride ?? configuredPath;
      if (!selectedPath) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "No policy path configured. Set a kernel policy path first in this page.",
        });
      }

      const resolved = await resolvePolicyPaths(selectedPath);
      const docs = await readPolicyDocuments(resolved);
      const policyCards = buildPolicyCards({
        policyRegistryJson: docs.policyRegistryJson,
        policyJson: docs.policyJson,
      });

      return {
        configuredPath,
        ...resolved,
        policyJson: docs.policyJson,
        policyRegistryJson: docs.policyRegistryJson,
        policyCards,
        policySectionMap: POLICY_SECTION_MAP,
      };
    }),

  savePolicyFiles: protectedProjectProcedure
    .input(SavePolicyFilesInputSchema)
    .output(LoadPolicyFilesOutputSchema)
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "project:update",
      });

      const project = await ctx.prisma.project.findUnique({
        where: { id: input.projectId, orgId: ctx.session.orgId },
        select: { metadata: true },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      const existingSettings = parsePolicyGovernanceSettings(project.metadata);
      const configuredPath = existingSettings.kernelPolicyPathAbsolute;
      const selectedPath = input.pathOverride ?? configuredPath;
      if (!selectedPath) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "No policy path configured. Set a kernel policy path first in this page.",
        });
      }

      const resolved = await resolvePolicyPaths(selectedPath);

      await writeFile(
        resolved.policyJsonPath,
        `${JSON.stringify(input.policyJson, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        resolved.policyRegistryPath,
        `${JSON.stringify(input.policyRegistryJson, null, 2)}\n`,
        "utf8",
      );

      const updatedPolicyGovernance = {
        ...existingSettings,
        kernelPolicyPathAbsolute: configuredPath,
        lastPolicyUpdatedAt: new Date().toISOString(),
      };
      const projectMetadata =
        project.metadata &&
        typeof project.metadata === "object" &&
        !Array.isArray(project.metadata)
          ? (project.metadata as Record<string, unknown>)
          : {};
      await ctx.prisma.project.update({
        where: { id: input.projectId, orgId: ctx.session.orgId },
        data: {
          metadata: {
            ...projectMetadata,
            policyGovernance: updatedPolicyGovernance,
          } as any,
        },
      });

      const policyCards = buildPolicyCards({
        policyRegistryJson: input.policyRegistryJson,
        policyJson: input.policyJson,
      });

      return {
        configuredPath,
        ...resolved,
        policyJson: input.policyJson,
        policyRegistryJson: input.policyRegistryJson,
        policyCards,
        policySectionMap: POLICY_SECTION_MAP,
      };
    }),

  generatePolicyUpdateProposal: protectedProjectProcedure
    .input(GeneratePolicyUpdateProposalInputSchema)
    .output(GeneratePolicyUpdateProposalOutputSchema)
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "project:update",
      });

      const user = ctx.session?.user;
      if (!user) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Please sign in to generate policy update suggestions.",
        });
      }

      if (!user.admin) {
        const projectRole = user.organizations
          .flatMap((org) => org.projects)
          .find((project) => project.id === input.projectId)?.role;
        if (
          !projectRole ||
          !projectRoleAccessRights[projectRole].includes("llmApiKeys:read")
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "User does not have access to run LLM policy update suggestions.",
          });
        }
      }

      const project = await ctx.prisma.project.findUnique({
        where: { id: input.projectId, orgId: ctx.session.orgId },
        select: { metadata: true },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      const llmApiKey = await ctx.prisma.llmApiKeys.findFirst({
        where: {
          projectId: input.projectId,
          adapter: LLMAdapter.OpenAI,
        },
      });
      if (!llmApiKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "No OpenAI-adapter LLM connection configured. Please add one in Settings -> LLM Connections.",
        });
      }

      const parsedKey = LLMApiKeySchema.safeParse(llmApiKey);
      if (!parsedKey.success) {
        logger.warn(
          "Failed to parse LLM API key for policy governance proposal",
          {
            projectId: input.projectId,
            policyName: input.policyName,
            error: parsedKey.error.message,
          },
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not parse LLM connection configuration.",
        });
      }

      const targetEntry = input.policyRegistryJson.find(
        (entry) => entry.name === input.policyName,
      );
      if (!targetEntry) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Policy "${input.policyName}" is not present in policy_registry.json.`,
        });
      }

      const editableSections = POLICY_SECTION_MAP[input.policyName] ?? [];
      const currentSections = Object.fromEntries(
        editableSections.map((section) => [
          section,
          input.policyJson[section] ?? null,
        ]),
      );

      const payload = {
        policyName: input.policyName,
        currentPolicyJson: input.policyJson,
        currentPolicyRegistryJson: input.policyRegistryJson,
        currentRegistryEntry: targetEntry,
        editableSections,
        currentSectionValues: currentSections,
        suggestion: input.suggestion,
        constraints: {
          mustStayFocusedOnTargetPolicy: true,
          preserveOtherPolicies: true,
          preserveUnrelatedConfig: true,
        },
      };

      const configuredModel = resolveErrorAnalysisModelFromMetadata(
        project.metadata,
      );
      const modelName =
        parsedKey.data.baseURL &&
        !parsedKey.data.baseURL.includes("api.openai.com") &&
        configuredModel === "gpt-5.2"
          ? "gpt-5.2"
          : resolveDemoOpenAIModel(configuredModel);

      const messages: ChatMessage[] = [
        {
          type: ChatMessageType.System,
          role: ChatMessageRole.System,
          content:
            "You are a policy refactoring assistant. Propose a safe, minimal update for exactly one policy. The goal is to implement a change that better matches the user's demonstrated preferences from past rejected confirmations and reduces future reject rate for the same intent, while preserving core safety constraints. Return ONLY valid JSON matching the schema with summary and proposedPolicyJson (the full updated policy.json object). Do not propose any changes to policy_registry.json. Keep changes scoped to the selected policy's listed editable config sections only, and preserve all unrelated keys exactly.",
        },
        {
          type: ChatMessageType.User,
          role: ChatMessageRole.User,
          content: JSON.stringify(payload),
        },
      ];

      let rawResult: unknown;
      try {
        rawResult = await fetchLLMCompletion({
          llmConnection: parsedKey.data,
          messages,
          modelParams: {
            provider: parsedKey.data.provider,
            adapter: LLMAdapter.OpenAI,
            model: modelName,
            temperature: 0.2,
            max_tokens: POLICY_UPDATE_PROPOSAL_MAX_TOKENS,
          },
          streaming: false,
          structuredOutputSchema: PolicyUpdateProposalStructuredOutputSchema,
        });
      } catch (e) {
        try {
          rawResult = await fetchLLMCompletion({
            llmConnection: parsedKey.data,
            messages,
            modelParams: {
              provider: parsedKey.data.provider,
              adapter: LLMAdapter.OpenAI,
              model: modelName,
              temperature: 0.2,
              max_tokens: POLICY_UPDATE_PROPOSAL_MAX_TOKENS,
            },
            streaming: false,
          });
        } catch (fallbackError) {
          const mappedFallback =
            mapLLMCompletionErrorToTRPCError(fallbackError);
          if (mappedFallback) throw mappedFallback;

          const mappedOriginal = mapLLMCompletionErrorToTRPCError(e);
          if (mappedOriginal) throw mappedOriginal;
          throw fallbackError;
        }
      }

      const proposal = parseProposalResult(rawResult);
      const proposedPolicyJson = {
        ...input.policyJson,
      } as Record<string, unknown>;
      for (const section of editableSections) {
        if (
          Object.prototype.hasOwnProperty.call(
            proposal.proposedPolicyJson,
            section,
          )
        ) {
          proposedPolicyJson[section] = proposal.proposedPolicyJson[section];
        }
      }
      const proposedPolicyRegistryJson = input.policyRegistryJson;
      const appliedSections = editableSections.filter(
        (section) =>
          JSON.stringify(proposedPolicyJson[section] ?? null) !==
          JSON.stringify(input.policyJson[section] ?? null),
      );

      return {
        policyName: input.policyName,
        summary: proposal.summary,
        appliedSections,
        proposedPolicyJson,
        proposedPolicyRegistryJson,
      };
    }),
});
