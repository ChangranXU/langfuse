import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import {
  ChatMessageRole,
  ChatMessageType,
  LLMAdapter,
  LLMApiKeySchema,
  singleFilter,
  type ChatMessage,
  type FilterState,
  type Observation,
} from "@langfuse/shared";
import {
  fetchLLMCompletion,
  getObservationsForTrace,
  getTraceById,
  isLLMCompletionError,
  logger,
} from "@langfuse/shared/src/server";
import { projectRoleAccessRights } from "@/src/features/rbac/constants/projectAccessRights";
import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import { type QueryType, viewVersions } from "@/src/features/query/types";
import { mapLegacyUiTableFilterToView } from "@/src/features/query/dashboardUiTableToViewMapping";
import { executeQuery } from "@/src/features/query/server/queryExecutor";
import {
  PolicySuggestionGenerateOutputSchema,
  PolicySuggestionModelSchema,
  PolicySuggestionResultSchema,
  PolicySuggestionStructuredOutputSchema,
} from "@/src/features/policy-suggestions/types";
import { resolveDemoOpenAIModel } from "@/src/features/error-analysis/types";

const MAX_REJECTED_TURNS = 4;
const MAX_OBSERVATIONS_PER_TURN = 6;
const MAX_IO_CHARS = 2000;

type RejectedTurnDetail = {
  traceId: string;
  traceName: string | null;
  turnIndex: number | null;
  nodeCount: number;
};

type SampledTurnContext = {
  traceId: string;
  traceName: string | null;
  traceTimestamp: string | null;
  turnIndex: number | null;
  policyTurnIndices: number[];
  examplePrompt: string | null;
  policyProtected: string | null;
  policyDescription: string | null;
  policySource: string | null;
  nodes: Array<{
    name: string;
    level: string | null;
    statusMessage: string | null;
    input: string | null;
    output: string | null;
    policyNames: string[];
  }>;
  relatedTurns: Array<{
    turnIndex: number | null;
    examplePrompt: string | null;
    policyProtected: string | null;
    nodes: Array<{
      name: string;
      level: string | null;
      statusMessage: string | null;
      input: string | null;
      output: string | null;
      policyNames: string[];
    }>;
  }>;
};

const GeneratePolicySuggestionInputSchema = z.object({
  projectId: z.string(),
  policyName: z.string().trim().min(1),
  globalFilterState: z.array(singleFilter).default([]),
  fromTimestamp: z.date(),
  toTimestamp: z.date(),
  version: viewVersions.optional().default("v1"),
});

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
  const parsedModel = PolicySuggestionModelSchema.safeParse(rawModel);
  return parsedModel.success ? parsedModel.data : ("gpt-5.2" as const);
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "[Unserializable value]";
  }
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 30))}\n...[truncated]`;
}

function getString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getMetadataRecord(metadata: unknown): Record<string, unknown> {
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
      // Ignore parse failures and fallback to empty object.
    }
  }

  return {};
}

export function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    );
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
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

export function parseStringRecord(value: unknown): Record<string, string> {
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

function parseTurnIndex(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getBooleanFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  return false;
}

function extractObservationPrompt(observation: Observation): string | null {
  const rawObservation = observation as unknown as Record<string, unknown>;
  const input = rawObservation.input;
  if (input == null) return null;
  const raw = safeStringify(input).trim();
  return raw ? truncateString(raw, MAX_IO_CHARS) : null;
}

function extractPolicyNames(metadata: Record<string, unknown>): string[] {
  const policyNames = new Set<string>([
    ...parseStringArray(metadata.policy_names),
    ...parseStringArray(metadata.policy_name),
  ]);
  Object.keys(parseStringRecord(metadata.policy_descriptions)).forEach((name) =>
    policyNames.add(name),
  );
  Object.keys(parseStringRecord(metadata.policy_sources)).forEach((name) =>
    policyNames.add(name),
  );
  return [...policyNames];
}

function isPolicyViolationObservation(params: {
  observation: Observation;
  policyName: string;
  confirmationTurnIndex: number | null;
}): boolean {
  const { observation, policyName, confirmationTurnIndex } = params;
  const metadata = getMetadataRecord(observation.metadata);
  const observationTurnIndex = parseTurnIndex(metadata.turn_index);
  if (
    confirmationTurnIndex != null &&
    observationTurnIndex != null &&
    observationTurnIndex > confirmationTurnIndex
  ) {
    return false;
  }

  const observationPolicyNames = extractPolicyNames(metadata);
  const hasMatchingPolicyName =
    observationPolicyNames.length === 0 ||
    observationPolicyNames.includes(policyName);
  const statusMessage = observation.statusMessage ?? "";
  const hasPolicySignal =
    observation.level === "POLICY_VIOLATION" ||
    getBooleanFlag(metadata.policy_violation) ||
    Boolean(getString(metadata.policy_protected)) ||
    statusMessage.includes("POLICY_BLOCK") ||
    statusMessage.includes("blocked by policy");

  return hasPolicySignal && hasMatchingPolicyName;
}

function getObservationDisplayInput(observation: Observation): string | null {
  const input =
    observation.input == null
      ? null
      : truncateString(safeStringify(observation.input), MAX_IO_CHARS);
  return input && input.trim().length > 0 ? input : null;
}

function getObservationDisplayOutput(observation: Observation): string | null {
  const output =
    observation.output == null
      ? null
      : truncateString(safeStringify(observation.output), MAX_IO_CHARS);
  return output && output.trim().length > 0 ? output : null;
}

function getPolicyProtectedFromObservation(
  observation: Observation,
): string | null {
  const metadata = getMetadataRecord(observation.metadata);
  const protectedReason = getString(metadata.policy_protected);
  if (protectedReason) return protectedReason;
  const statusMessage = observation.statusMessage?.trim() ?? "";
  if (
    statusMessage.includes("POLICY_BLOCK") ||
    statusMessage.includes("blocked by policy")
  ) {
    return statusMessage;
  }
  return null;
}

function buildTurnNodes(observations: Observation[]) {
  return observations.map((observation) => {
    const metadata = getMetadataRecord(observation.metadata);
    return {
      name: observation.name || observation.id,
      level: observation.level ?? null,
      statusMessage: observation.statusMessage ?? null,
      input: getObservationDisplayInput(observation),
      output: getObservationDisplayOutput(observation),
      policyNames: extractPolicyNames(metadata),
    };
  });
}

function parseSuggestedOutput(rawResult: unknown) {
  const direct = PolicySuggestionResultSchema.safeParse(rawResult);
  if (direct.success) return direct.data;

  if (typeof rawResult === "string") {
    try {
      const parsed = JSON.parse(rawResult);
      return PolicySuggestionResultSchema.parse(parsed);
    } catch {
      // handled below
    }
  }

  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "LLM returned an invalid policy suggestion payload (schema mismatch).",
  });
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

async function getRejectedTurnDetails(params: {
  projectId: string;
  policyName: string;
  globalFilterState: FilterState;
  fromTimestamp: Date;
  toTimestamp: Date;
  version: z.infer<typeof viewVersions>;
}): Promise<RejectedTurnDetail[]> {
  const query: QueryType = {
    view: "observations",
    dimensions: [
      { field: "policyName" },
      { field: "traceId" },
      { field: "traceName" },
      { field: "policyConfirmationTurnIndex" },
    ],
    metrics: [{ measure: "count", aggregation: "count" }],
    filters: [
      ...mapLegacyUiTableFilterToView("observations", params.globalFilterState),
      {
        column: "metadata",
        key: "policy_confirmation_state",
        operator: "=",
        value: "rejected",
        type: "stringObject",
      },
    ],
    timeDimension: null,
    fromTimestamp: params.fromTimestamp.toISOString(),
    toTimestamp: params.toTimestamp.toISOString(),
    orderBy: [{ field: "count_count", direction: "desc" }],
    chartConfig: { type: "table", row_limit: 500 },
  };

  const rows = await executeQuery(
    params.projectId,
    query,
    params.version,
    params.version === "v2",
  );

  const deduped = new Map<string, RejectedTurnDetail>();
  for (const row of rows) {
    const policyName =
      typeof row.policyName === "string" ? row.policyName.trim() : "";
    if (policyName !== params.policyName) continue;

    const traceId = typeof row.traceId === "string" ? row.traceId.trim() : "";
    if (!traceId) continue;

    const turnIndex = parseTurnIndex(row.policyConfirmationTurnIndex);
    const key = `${traceId}::${turnIndex ?? "null"}`;
    if (deduped.has(key)) continue;

    deduped.set(key, {
      traceId,
      traceName:
        typeof row.traceName === "string" && row.traceName.trim().length > 0
          ? row.traceName.trim()
          : null,
      turnIndex,
      nodeCount:
        typeof row.count_count === "number"
          ? row.count_count
          : Number(row.count_count ?? 0),
    });
  }

  return [...deduped.values()].sort((a, b) => b.nodeCount - a.nodeCount);
}

export function buildSampledTurnContext(params: {
  policyName: string;
  detail: RejectedTurnDetail;
  trace: unknown;
  observations: Observation[];
}): SampledTurnContext | null {
  const { policyName, detail, trace, observations } = params;
  if (!trace) return null;

  const policyViolationTurnIndices = Array.from(
    new Set(
      observations
        .filter((observation) =>
          isPolicyViolationObservation({
            observation,
            policyName,
            confirmationTurnIndex: detail.turnIndex,
          }),
        )
        .map((observation) =>
          parseTurnIndex(getMetadataRecord(observation.metadata).turn_index),
        )
        .filter((turnIndex): turnIndex is number => turnIndex != null),
    ),
  ).sort((a, b) => a - b);

  const selectedTurnIndices =
    policyViolationTurnIndices.length > 0
      ? policyViolationTurnIndices
      : detail.turnIndex != null
        ? [detail.turnIndex]
        : [];

  const relatedTurns = selectedTurnIndices
    .map((turnIndex) => {
      const turnObservations = observations
        .filter((observation) => {
          const metadata = getMetadataRecord(observation.metadata);
          return parseTurnIndex(metadata.turn_index) === turnIndex;
        })
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
        .slice(0, MAX_OBSERVATIONS_PER_TURN);

      if (turnObservations.length === 0) return null;

      let turnPolicyProtected: string | null = null;
      let turnExamplePrompt: string | null = null;
      for (const observation of turnObservations) {
        if (!turnPolicyProtected) {
          turnPolicyProtected = getPolicyProtectedFromObservation(observation);
        }
        if (!turnExamplePrompt) {
          turnExamplePrompt =
            getObservationDisplayInput(observation) ??
            extractObservationPrompt(observation);
        }
      }

      return {
        turnIndex,
        examplePrompt: turnExamplePrompt,
        policyProtected: turnPolicyProtected,
        nodes: buildTurnNodes(turnObservations),
      };
    })
    .filter(
      (turn): turn is NonNullable<SampledTurnContext["relatedTurns"][number]> =>
        turn !== null,
    );

  const nodes = relatedTurns.flatMap((turn) => turn.nodes);
  if (nodes.length === 0) return null;

  let policyProtected: string | null = null;
  let policyDescription: string | null = null;
  let policySource: string | null = null;
  let examplePrompt: string | null = null;

  for (const observation of observations) {
    const metadata = getMetadataRecord(observation.metadata);
    if (
      !policyDescription ||
      !policySource ||
      !policyProtected ||
      !examplePrompt
    ) {
      const turnIndex = parseTurnIndex(metadata.turn_index);
      if (
        selectedTurnIndices.length > 0 &&
        turnIndex != null &&
        !selectedTurnIndices.includes(turnIndex)
      ) {
        continue;
      }
    }

    if (!policyProtected) {
      policyProtected = getPolicyProtectedFromObservation(observation);
    }

    const descriptions = parseStringRecord(metadata.policy_descriptions);
    if (!policyDescription && descriptions[policyName]) {
      policyDescription = descriptions[policyName]!;
    }

    const sources = parseStringRecord(metadata.policy_sources);
    if (!policySource && sources[policyName]) {
      policySource = sources[policyName]!;
    }

    if (!examplePrompt) {
      examplePrompt =
        getObservationDisplayInput(observation) ??
        extractObservationPrompt(observation);
    }
  }

  const rawTrace = trace as unknown as Record<string, unknown>;
  if (!examplePrompt) {
    const traceInput = rawTrace.input;
    if (traceInput != null) {
      const serializedTraceInput = safeStringify(traceInput).trim();
      if (serializedTraceInput) {
        examplePrompt = truncateString(serializedTraceInput, MAX_IO_CHARS);
      }
    }
  }

  return {
    traceId: detail.traceId,
    traceName: detail.traceName,
    traceTimestamp:
      rawTrace.timestamp instanceof Date
        ? rawTrace.timestamp.toISOString()
        : null,
    turnIndex: detail.turnIndex,
    policyTurnIndices: selectedTurnIndices,
    examplePrompt,
    policyProtected,
    policyDescription,
    policySource,
    nodes,
    relatedTurns,
  };
}

export const policySuggestionRouter = createTRPCRouter({
  generate: protectedProjectProcedure
    .input(GeneratePolicySuggestionInputSchema)
    .output(PolicySuggestionGenerateOutputSchema)
    .mutation(async ({ input, ctx }) => {
      if (input.fromTimestamp > input.toTimestamp) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "fromTimestamp must be before toTimestamp.",
        });
      }

      const user = ctx.session?.user;
      if (!user) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Please sign in to generate policy suggestions.",
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
            message: "User does not have access to run LLM policy suggestions.",
          });
        }
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

      const projectSettings = await ctx.prisma.project.findUnique({
        where: {
          id: input.projectId,
        },
        select: {
          metadata: true,
        },
      });
      const configuredModel = resolveErrorAnalysisModelFromMetadata(
        projectSettings?.metadata,
      );

      const parsedKey = LLMApiKeySchema.safeParse(llmApiKey);
      if (!parsedKey.success) {
        logger.warn("Failed to parse LLM API key for policy suggestions", {
          projectId: input.projectId,
          policyName: input.policyName,
          error: parsedKey.error.message,
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not parse LLM connection configuration.",
        });
      }

      const rejectedTurnDetails = await getRejectedTurnDetails({
        projectId: input.projectId,
        policyName: input.policyName,
        globalFilterState: input.globalFilterState,
        fromTimestamp: input.fromTimestamp,
        toTimestamp: input.toTimestamp,
        version: input.version,
      });

      if (rejectedTurnDetails.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "No rejected turns found for this policy in the selected range.",
        });
      }

      const sampledDetails = rejectedTurnDetails.slice(0, MAX_REJECTED_TURNS);
      const sampledTurns = await Promise.all(
        sampledDetails.map(async (detail) => {
          const [trace, observations] = await Promise.all([
            getTraceById({
              traceId: detail.traceId,
              projectId: input.projectId,
            }),
            getObservationsForTrace({
              traceId: detail.traceId,
              projectId: input.projectId,
              includeIO: true,
            }),
          ]);

          return buildSampledTurnContext({
            policyName: input.policyName,
            detail,
            trace,
            observations: observations as Observation[],
          });
        }),
      );

      const cleanSampledTurns = sampledTurns.filter(
        (turn): turn is SampledTurnContext => turn !== null,
      );

      if (cleanSampledTurns.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "Unable to build policy context from rejected turns in the selected range.",
        });
      }

      const payload = {
        policyName: input.policyName,
        timeRange: {
          from: input.fromTimestamp.toISOString(),
          to: input.toTimestamp.toISOString(),
        },
        summary: {
          rejectedTurnCount: rejectedTurnDetails.length,
          sampledRejectedTurns: cleanSampledTurns.length,
          sampledPolicyViolationTurns: cleanSampledTurns.reduce(
            (sum, turn) => sum + turn.policyTurnIndices.length,
            0,
          ),
        },
        examples: cleanSampledTurns,
        instructions: {
          objective:
            "Recommend a policy-level change that improves the policy itself while preserving core safety constraints. Focus on the rule, scope, matching logic, allowlist/denylist criteria, path/tool boundaries, thresholds, or policy wording.",
          format:
            "suggestion should be 1-2 lines; reason should be 2-3 lines and grounded in the provided examples.",
          constraints:
            "Do not propose bypassing policy/safety checks. Focus on policy text quality and actionable clarification.",
          grounding:
            "Prioritize evidence from policy-violation turns and explicit policy-block messages. Treat downstream non-policy execution failures such as 'File not found' as separate operational issues unless the policy-violation turns themselves show that the policy caused them.",
          exclusions:
            "Do not suggest changing the wording of the violation message, confirmation prompt, response phrasing, UI flow, or other communication/UX details unless the underlying policy text itself is part of the problem. The recommendation must be about modifying the policy itself.",
        },
      };

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
            "You are a policy-quality assistant. Based on policy enforcement evidence and rejected-turn examples, propose a concise policy modification suggestion. Keep the recommendation safe and do not suggest bypassing policy constraints. Ground your answer primarily in policy-violation turns and explicit policy-block evidence; do not blame later tool execution errors unless the policy evidence clearly supports that conclusion. Recommend changes to the policy itself only: policy rule, scope, thresholds, allowlist/denylist logic, or policy wording. Do not recommend UI-copy, confirmation-prompt, or response-message changes unless the policy text itself must change. Return only JSON matching the schema.",
        },
        {
          type: ChatMessageType.User,
          role: ChatMessageRole.User,
          content: safeStringify(payload),
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
            max_tokens: 400,
          },
          streaming: false,
          structuredOutputSchema: PolicySuggestionStructuredOutputSchema,
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
              max_tokens: 400,
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

      const suggestion = parseSuggestedOutput(rawResult);

      return {
        policyName: input.policyName,
        suggestion,
        sampledRejectedTurns: cleanSampledTurns.length,
      };
    }),
});
