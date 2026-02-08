import { TRPCError } from "@trpc/server";
import { projectRoleAccessRights } from "@/src/features/rbac/constants/projectAccessRights";
import {
  createTRPCRouter,
  protectedGetTraceProcedure,
} from "@/src/server/api/trpc";
import {
  type ChatMessage,
  ChatMessageRole,
  ChatMessageType,
  LLMAdapter,
  LLMApiKeySchema,
  type Observation,
} from "@langfuse/shared";
import {
  fetchLLMCompletion,
  getObservationsForTrace,
  getObservationByIdFromEventsTable,
  logger,
  isLLMCompletionError,
  setEventErrorTypeTag,
} from "@langfuse/shared/src/server";
import {
  ErrorAnalysisAnalyzeInputSchema,
  ErrorAnalysisAnalyzeOutputSchema,
  ErrorAnalysisLLMResultSchema,
  ErrorAnalysisStructuredOutputSchema,
  ErrorTypeClassificationResultSchema,
  ErrorTypeStructuredOutputSchema,
  ERROR_TYPE_CATALOG,
  resolveDemoOpenAIModel,
} from "../types";
import { z } from "zod/v4";

function formatUnknownErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const anyErr = error as any;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(anyErr?.code ? { code: anyErr.code } : {}),
      ...(anyErr?.meta ? { meta: anyErr.meta } : {}),
    };
  }

  // Prisma sometimes throws plain objects
  if (error && typeof error === "object") {
    try {
      return { error: JSON.stringify(error) };
    } catch {
      return { error: "[Unserializable object]" };
    }
  }

  return { error: String(error) };
}

function extractFirstJsonObject(text: string): string | null {
  // Extract the first syntactically complete JSON object from a possibly noisy response.
  // Handles leading/trailing text and ignores braces inside strings.
  const s = text.trim();
  if (!s) return null;

  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start !== -1) {
        return s.slice(start, i + 1);
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
      // try next
    }
  }

  throw new Error("Could not parse JSON object from LLM response.");
}

function normalizeErrorAnalysisResult(raw: unknown): unknown {
  // Best-effort normalization for providers that return slightly different key shapes.
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;

  const rootCause = obj.rootCause ?? obj.root_cause ?? obj["root_cause"];
  const resolveNow =
    obj.resolveNow ??
    obj.resolve_now ??
    obj["resolve_now"] ??
    obj.resolutionNow ??
    obj.resolution_now ??
    obj["resolution_now"];
  const preventionNextCall =
    obj.preventionNextCall ??
    obj.prevention_next_call ??
    obj["prevention_next_call"];
  const relevantObservations =
    obj.relevantObservations ??
    obj.relevant_observations ??
    obj["relevant_observations"];
  const contextSufficient =
    obj.contextSufficient ??
    obj.context_sufficient ??
    obj["context_sufficient"] ??
    obj.contextEnough ??
    obj.context_enough ??
    obj["context_enough"];
  const confidence =
    obj.confidence ?? obj.confidenceScore ?? obj.confidence_score;

  const normalized: Record<string, unknown> = {
    ...(rootCause !== undefined ? { rootCause } : {}),
    ...(resolveNow !== undefined ? { resolveNow } : {}),
    ...(preventionNextCall !== undefined ? { preventionNextCall } : {}),
    ...(relevantObservations !== undefined ? { relevantObservations } : {}),
    ...(contextSufficient !== undefined ? { contextSufficient } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };

  return Object.keys(normalized).length > 0 ? { ...obj, ...normalized } : raw;
}

function coerceToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Common patterns from LLMs / proxies
    for (const key of [
      "text",
      "content",
      "summary",
      "message",
      "reason",
      "rootCause",
      "root_cause",
    ]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim().length > 0) return v;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "[Unserializable value]";
    }
  }
  return String(value);
}

function coerceToStringArray(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value
      .map(coerceToString)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const s = value.trim();
    return s ? [s] : [];
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Try common container keys first
    for (const key of [
      "items",
      "steps",
      "actions",
      "suggestions",
      "resolveNow",
      "resolve_now",
      "resolutionNow",
      "resolution_now",
      "preventionNextCall",
      "prevention_next_call",
    ]) {
      const v = obj[key];
      if (Array.isArray(v)) return coerceToStringArray(v);
      if (typeof v === "string") return coerceToStringArray(v);
    }
    // Otherwise, flatten values
    return Object.values(obj).flatMap((v) => coerceToStringArray(v));
  }
  return [coerceToString(value)].map((s) => s.trim()).filter(Boolean);
}

function coerceConfidence(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : typeof value === "object" && value && "value" in (value as any)
          ? Number.parseFloat(String((value as any).value))
          : NaN;
  const safe = Number.isFinite(n) ? n : 0.5;
  return Math.max(0, Math.min(1, safe));
}

function coerceBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(s)) return true;
    if (["false", "no", "n", "0"].includes(s)) return false;
  }
  // Default to "sufficient" to avoid false negatives driving re-runs unnecessarily.
  return true;
}

function coerceErrorAnalysisResult(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;

  return {
    ...obj,
    rootCause: coerceToString(obj.rootCause),
    resolveNow: coerceToStringArray(obj.resolveNow),
    preventionNextCall: coerceToStringArray(obj.preventionNextCall),
    relevantObservations: coerceToStringArray(obj.relevantObservations),
    contextSufficient: coerceBoolean(obj.contextSufficient),
    confidence: coerceConfidence(obj.confidence),
  };
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
        " Check Settings → LLM Connections (API key / permissions / base URL).",
    });
  }

  if (status === 404) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        baseMessage +
        " The selected model may not exist on your configured OpenAI-compatible endpoint.",
    });
  }

  if (status === 429) {
    return new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: baseMessage + " Please retry shortly.",
    });
  }

  // For self-hosted/dev, prefer actionable feedback over generic 5xx masking.
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: baseMessage,
  });
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
  return value.slice(0, Math.max(0, maxChars - 30)) + "\n...[truncated]";
}

function slugifyErrorTypeKey(input: string): string {
  const lowered = input.trim().toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, "_");
  const collapsed = replaced.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const safe = collapsed.length > 0 ? collapsed : "other";
  return safe.slice(0, 48);
}

function buildErrorTypeClassificationUserContent(params: {
  issue: string;
  rootCause: string;
  observation: ReturnType<typeof buildObservationPreview>;
}): string {
  return safeStringify({
    issue: params.issue,
    rootCause: params.rootCause,
    observation: {
      id: params.observation.id,
      type: params.observation.type,
      name: params.observation.name,
      level: params.observation.level,
      statusMessage: params.observation.statusMessage,
      model: params.observation.model,
      internalModelId: params.observation.internalModelId,
      input:
        params.observation.input == null
          ? null
          : truncateString(params.observation.input, 2_000),
      output:
        params.observation.output == null
          ? null
          : truncateString(params.observation.output, 2_000),
    },
    typeCatalog: Object.fromEntries(
      Object.entries(ERROR_TYPE_CATALOG).map(([k, v]) => [k, v.description]),
    ),
    instruction:
      "Classify the error/warning type. Choose from the catalog. If none match well, set selectedType=OTHER and propose a short label + description.",
  });
}

function buildObservationPreview(params: {
  observation: Observation;
  ioMaxChars: number;
}) {
  const { observation, ioMaxChars } = params;
  const inputStr =
    observation.input == null
      ? null
      : truncateString(safeStringify(observation.input), ioMaxChars);
  const outputStr =
    observation.output == null
      ? null
      : truncateString(safeStringify(observation.output), ioMaxChars);

  return {
    id: observation.id,
    type: observation.type,
    name: observation.name,
    startTime: observation.startTime,
    endTime: observation.endTime,
    level: observation.level,
    statusMessage: observation.statusMessage,
    model: observation.model,
    internalModelId: observation.internalModelId,
    input: inputStr,
    output: outputStr,
  };
}

function buildIssueLabel(params: { observation: Observation }): string {
  const { observation } = params;

  const nodeName = observation.name || observation.id;
  const tag = observation.level ?? "UNKNOWN";
  const info =
    observation.statusMessage ??
    (observation.output == null
      ? ""
      : truncateString(safeStringify(observation.output), 800));

  return `${nodeName} [${tag}] ${info}`.trim();
}

function buildObservationPath(params: {
  observations: Observation[];
  observationId: string;
}): Observation[] {
  const { observations, observationId } = params;
  const byId = new Map(observations.map((o) => [o.id, o]));
  const path: Observation[] = [];

  let current = byId.get(observationId);
  // If not found, return empty path and let caller handle
  while (current) {
    path.unshift(current);
    const parentId = current.parentObservationId;
    if (!parentId) break;
    current = byId.get(parentId) ?? undefined;
  }

  return path;
}

function orderObservationsForTrace(observations: Observation[]): Observation[] {
  // Stable-ish ordering for "trace distance" computations.
  // Prefer timestamps; fall back to id for deterministic ordering.
  return [...observations].sort((a, b) => {
    const aStart = a.startTime ? a.startTime.getTime() : 0;
    const bStart = b.startTime ? b.startTime.getTime() : 0;
    if (aStart !== bStart) return aStart - bStart;

    const aEnd = a.endTime ? a.endTime.getTime() : 0;
    const bEnd = b.endTime ? b.endTime.getTime() : 0;
    if (aEnd !== bEnd) return aEnd - bEnd;

    return a.id.localeCompare(b.id);
  });
}

type ContextNode = {
  idx: number; // index in ordered trace list
  preview: ReturnType<typeof buildObservationPreview>;
};

function buildContextWindowNodes(params: {
  ordered: Observation[];
  focusIndex: number;
  beforeCount: number;
  afterCount: number;
  ioMaxChars: number;
}): { before: ContextNode[]; after: ContextNode[] } {
  const { ordered, focusIndex, beforeCount, afterCount, ioMaxChars } = params;

  const beforeStart = Math.max(0, focusIndex - beforeCount);
  const beforeEnd = Math.max(0, focusIndex); // exclusive
  const afterStart = Math.min(ordered.length, focusIndex + 1);
  const afterEnd = Math.min(ordered.length, focusIndex + 1 + afterCount); // exclusive

  const before: ContextNode[] = [];
  for (let i = beforeStart; i < beforeEnd; i++) {
    const o = ordered[i]!;
    before.push({
      idx: i,
      preview: buildObservationPreview({ observation: o, ioMaxChars }),
    });
  }

  const after: ContextNode[] = [];
  for (let i = afterStart; i < afterEnd; i++) {
    const o = ordered[i]!;
    after.push({
      idx: i,
      preview: buildObservationPreview({ observation: o, ioMaxChars }),
    });
  }

  return { before, after };
}

type TraceLikeForContext = {
  id: string;
  name: string | null;
  projectId: string;
  timestamp: Date;
  environment: string | null;
  release: string | null;
  version: string | null;
  userId: string | null;
  sessionId: string | null;
  tags: string[] | null;
  input: unknown;
  output: unknown;
};

function isContextLengthExceededError(e: unknown): boolean {
  if (!isLLMCompletionError(e)) return false;

  const status = e.responseStatusCode ?? 500;
  if (![400, 413, 422].includes(status)) return false;

  const msg = e.message.toLowerCase();
  return (
    msg.includes("maximum context") ||
    msg.includes("context length") ||
    msg.includes("context_length") ||
    msg.includes("too many tokens") ||
    msg.includes("token limit") ||
    msg.includes("prompt is too long") ||
    msg.includes("request too large") ||
    msg.includes("payload too large")
  );
}

function buildErrorAnalysisContextPayload(params: {
  trace: TraceLikeForContext;
  currentObservation: Observation;
  issue: string;
  path: Observation[];
  orderedCount: number;
  focusIndex: number;
  beforeNodes: ContextNode[];
  afterNodes: ContextNode[];
}) {
  const {
    trace,
    currentObservation,
    issue,
    path,
    orderedCount,
    focusIndex,
    beforeNodes,
    afterNodes,
  } = params;

  return {
    trace: {
      id: trace.id,
      name: trace.name,
      projectId: trace.projectId,
      timestamp: trace.timestamp,
      environment: trace.environment,
      release: trace.release,
      version: trace.version,
      userId: trace.userId,
      sessionId: trace.sessionId,
      tags: trace.tags,
      input: trace.input
        ? truncateString(safeStringify(trace.input), 10_000)
        : null,
      output: trace.output
        ? truncateString(safeStringify(trace.output), 10_000)
        : null,
    },
    currentObservation: buildObservationPreview({
      observation: currentObservation,
      ioMaxChars: 10_000,
    }),
    issue,
    contextWindow: {
      // Trace-local "distance" is based on indices in this ordered list.
      traceOrder: {
        focusIndex,
        totalNodes: orderedCount,
      },
      before: beforeNodes.map((n) => n.preview),
      after: afterNodes.map((n) => n.preview),
    },
    path: path.map((o) =>
      buildObservationPreview({ observation: o, ioMaxChars: 6_000 }),
    ),
    note: {
      instruction:
        "Analyze the ERROR/WARNING. Output MUST match the schema. Also decide whether the provided contextWindow is sufficient to support your conclusion. If not sufficient, set contextSufficient=false and still provide best-effort hypotheses. Provide (a) root cause, (b) how to resolve now (if applicable), (c) how to prevent in the NEXT call, (d) relevant observation ids, (e) confidence score (0-1).",
    },
  };
}

function buildErrorAnalysisUserContent(
  params: Parameters<typeof buildErrorAnalysisContextPayload>[0],
): string {
  return safeStringify(buildErrorAnalysisContextPayload(params));
}

function pruneContextWindowOnce(params: {
  focusIndex: number;
  beforeNodes: ContextNode[];
  afterNodes: ContextNode[];
}) {
  const { focusIndex, beforeNodes, afterNodes } = params;

  if (beforeNodes.length === 0 && afterNodes.length === 0) return;

  const distBefore =
    beforeNodes.length > 0
      ? focusIndex - beforeNodes[0]!.idx
      : Number.NEGATIVE_INFINITY;
  const distAfter =
    afterNodes.length > 0
      ? afterNodes[afterNodes.length - 1]!.idx - focusIndex
      : Number.NEGATIVE_INFINITY;

  if (distBefore > distAfter) {
    beforeNodes.shift();
    return;
  }

  if (distAfter > distBefore) {
    afterNodes.pop();
    return;
  }

  // Same distance: remove the bigger node payload first.
  const beforeSize =
    beforeNodes.length > 0 ? safeStringify(beforeNodes[0]!.preview).length : -1;
  const afterSize =
    afterNodes.length > 0
      ? safeStringify(afterNodes[afterNodes.length - 1]!.preview).length
      : -1;
  if (beforeSize >= afterSize) beforeNodes.shift();
  else afterNodes.pop();
}

export const errorAnalysisRouter = createTRPCRouter({
  analyze: protectedGetTraceProcedure
    .input(ErrorAnalysisAnalyzeInputSchema)
    .output(ErrorAnalysisAnalyzeOutputSchema)
    .mutation(async ({ input, ctx }) => {
      // RBAC: require project membership + LLM key read scope (public traces are not sufficient).
      const user = ctx.session?.user;
      if (!user) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Please sign in to run LLM analysis.",
        });
      }

      if (!user.admin) {
        const projectRole = user.organizations
          .flatMap((org) => org.projects)
          .find((p) => p.id === input.projectId)?.role;

        if (
          !projectRole ||
          !projectRoleAccessRights[projectRole].includes("llmApiKeys:read")
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "User does not have access to run LLM analysis.",
          });
        }
      }

      // Require an OpenAI-adapter connection for demo models.
      const llmApiKey = await ctx.prisma.llmApiKeys.findFirst({
        where: { projectId: input.projectId, adapter: LLMAdapter.OpenAI },
      });

      if (!llmApiKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "No OpenAI-adapter LLM connection configured. Please add one in Settings → LLM Connections.",
        });
      }

      const parsedKey = LLMApiKeySchema.safeParse(llmApiKey);
      if (!parsedKey.success) {
        logger.warn("Failed to parse LLM API key for error analysis", {
          projectId: input.projectId,
          error: parsedKey.error.message,
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not parse LLM connection configuration.",
        });
      }

      const observations = (await getObservationsForTrace({
        traceId: input.traceId,
        projectId: input.projectId,
        // We intentionally do NOT pass `timestamp` here: for error/warning analysis we want
        // to include a small amount of context AFTER the focus observation as well.
        // If the resulting prompt is too large, we rely on the LLM API context-length error
        // and prune contextWindow nodes by trace distance before retrying.
        timestamp: undefined,
        includeIO: true,
      })) as Observation[];

      const path = buildObservationPath({
        observations,
        observationId: input.observationId,
      });

      const currentObservation =
        observations.find((o) => o.id === input.observationId) ?? null;
      if (!currentObservation) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Observation not found for this trace.",
        });
      }

      const trace = ctx.trace;
      const ordered = orderObservationsForTrace(observations);
      const focusIndex = ordered.findIndex((o) => o.id === input.observationId);
      if (focusIndex === -1) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Observation not found in ordered trace context.",
        });
      }

      const issue = buildIssueLabel({ observation: currentObservation });

      const DEFAULT_AFTER = 5;
      const BEFORE_ATTEMPTS = [5, 20, 50];
      const LOW_CONFIDENCE_THRESHOLD = 0.6;

      const runWithBeforeCount = async (beforeCount: number) => {
        const window = buildContextWindowNodes({
          ordered,
          focusIndex,
          beforeCount,
          afterCount: DEFAULT_AFTER,
          ioMaxChars: 4_000,
        });

        const modelName =
          // If the OpenAI adapter is configured with a non-OpenAI base URL (proxy),
          // prefer the user-facing model name to maximize compatibility.
          parsedKey.data.baseURL &&
          !parsedKey.data.baseURL.includes("api.openai.com") &&
          input.model === "gpt-5.2"
            ? "gpt-5.2"
            : resolveDemoOpenAIModel(input.model);

        const callLLMOnce = async (
          messages: ChatMessage[],
        ): Promise<unknown> => {
          try {
            return await fetchLLMCompletion({
              llmConnection: parsedKey.data,
              messages,
              modelParams: {
                provider: parsedKey.data.provider,
                adapter: LLMAdapter.OpenAI,
                model: modelName,
                temperature: 0.2,
                max_tokens: 800,
              },
              streaming: false,
              structuredOutputSchema: ErrorAnalysisStructuredOutputSchema,
            });
          } catch (e) {
            // Let context-length errors bubble up so the caller can prune and retry.
            if (isContextLengthExceededError(e)) throw e;

            const mapped = mapLLMCompletionErrorToTRPCError(e);
            if (mapped) throw mapped;

            // Fallback path: plain completion → extract/parse JSON object.
            try {
              return parseJsonObjectFromCompletion(
                await fetchLLMCompletion({
                  llmConnection: parsedKey.data,
                  messages,
                  modelParams: {
                    provider: parsedKey.data.provider,
                    adapter: LLMAdapter.OpenAI,
                    model: modelName,
                    temperature: 0.2,
                    max_tokens: 800,
                  },
                  streaming: false,
                }),
              );
            } catch (fallbackError) {
              if (isContextLengthExceededError(fallbackError))
                throw fallbackError;

              const mappedFallback =
                mapLLMCompletionErrorToTRPCError(fallbackError);
              if (mappedFallback) throw mappedFallback;

              throw fallbackError;
            }
          }
        };

        let rawResult: unknown | undefined;
        let lastContextError: unknown | null = null;
        const maxPruneAttempts = window.before.length + window.after.length;

        for (let attempt = 0; attempt <= maxPruneAttempts; attempt++) {
          const userContent = buildErrorAnalysisUserContent({
            trace,
            currentObservation,
            issue,
            path,
            orderedCount: ordered.length,
            focusIndex,
            beforeNodes: window.before,
            afterNodes: window.after,
          });

          const messages: ChatMessage[] = [
            {
              type: ChatMessageType.System,
              role: ChatMessageRole.System,
              content:
                "You are an expert debugger for LLM application traces. Return ONLY the structured JSON object that matches the provided schema.",
            },
            {
              type: ChatMessageType.User,
              role: ChatMessageRole.User,
              content: userContent,
            },
          ];

          try {
            rawResult = await callLLMOnce(messages);
            break;
          } catch (e) {
            if (
              isContextLengthExceededError(e) &&
              (window.before.length > 0 || window.after.length > 0)
            ) {
              lastContextError = e;
              logger.info(
                "Error analysis prompt exceeded LLM context length; pruning nodes",
                {
                  projectId: input.projectId,
                  traceId: input.traceId,
                  observationId: input.observationId,
                  beforeNodes: window.before.length,
                  afterNodes: window.after.length,
                  responseStatusCode: isLLMCompletionError(e)
                    ? e.responseStatusCode
                    : undefined,
                },
              );
              pruneContextWindowOnce({
                focusIndex,
                beforeNodes: window.before,
                afterNodes: window.after,
              });
              continue;
            }

            throw e;
          }
        }

        if (rawResult === undefined) {
          const mapped = mapLLMCompletionErrorToTRPCError(lastContextError);
          if (mapped) throw mapped;
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "LLM request failed due to context length limits. Please reduce trace verbosity/context and retry.",
          });
        }

        const normalized = normalizeErrorAnalysisResult(rawResult);
        const coerced = coerceErrorAnalysisResult(normalized);
        const validated = ErrorAnalysisLLMResultSchema.safeParse(coerced);
        if (!validated.success) {
          logger.warn(
            "LLM returned invalid structured output for error analysis",
            {
              projectId: input.projectId,
              traceId: input.traceId,
              observationId: input.observationId,
              error: validated.error.message,
            },
          );
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "LLM returned an invalid analysis payload (not matching the expected schema). " +
              validated.error.message,
          });
        }

        return { modelName, data: validated.data };
      };

      let final: Awaited<ReturnType<typeof runWithBeforeCount>> | null = null;
      for (const beforeCount of BEFORE_ATTEMPTS) {
        final = await runWithBeforeCount(beforeCount);
        // If the LLM says context is insufficient (or confidence is low), expand backwards.
        if (
          final.data.confidence >= LOW_CONFIDENCE_THRESHOLD &&
          final.data.contextSufficient
        ) {
          break;
        }
      }
      if (!final) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to run error analysis.",
        });
      }

      // Second pass: classify error/warning type (best-effort).
      let errorType: string | null = null;
      let errorTypeDescription: string | null = null;
      let errorTypeWhy: string | null = null;
      let errorTypeConfidence: number | null = null;
      let errorTypeFromList: boolean | null = null;

      try {
        const classificationMessages: ChatMessage[] = [
          {
            type: ChatMessageType.System,
            role: ChatMessageRole.System,
            content:
              "You are an expert at classifying error/warning types in LLM traces. Return ONLY the structured JSON object that matches the provided schema.",
          },
          {
            type: ChatMessageType.User,
            role: ChatMessageRole.User,
            content: buildErrorTypeClassificationUserContent({
              issue,
              rootCause: final.data.rootCause,
              observation: buildObservationPreview({
                observation: currentObservation,
                ioMaxChars: 2_000,
              }),
            }),
          },
        ];

        const modelName =
          parsedKey.data.baseURL &&
          !parsedKey.data.baseURL.includes("api.openai.com") &&
          input.model === "gpt-5.2"
            ? "gpt-5.2"
            : resolveDemoOpenAIModel(input.model);

        const rawClassification = await fetchLLMCompletion({
          llmConnection: parsedKey.data,
          messages: classificationMessages,
          modelParams: {
            provider: parsedKey.data.provider,
            adapter: LLMAdapter.OpenAI,
            model: modelName,
            temperature: 0,
            max_tokens: 250,
          },
          streaming: false,
          structuredOutputSchema: ErrorTypeStructuredOutputSchema,
        });

        const validated =
          ErrorTypeClassificationResultSchema.safeParse(rawClassification);
        if (!validated.success) {
          throw new Error(validated.error.message);
        }

        const v = validated.data;
        errorTypeConfidence = v.confidence;
        errorTypeWhy = v.why;

        if (v.selectedType === "OTHER") {
          const label = (v.otherTypeLabel ?? "").trim();
          const desc = (v.otherTypeDescription ?? "").trim();
          if (!label || !desc) {
            throw new Error(
              "selectedType=OTHER requires otherTypeLabel and otherTypeDescription",
            );
          }
          errorType = `other_${slugifyErrorTypeKey(label)}`;
          errorTypeDescription = desc;
          errorTypeFromList = false;
        } else {
          errorType = v.selectedType;
          errorTypeDescription =
            (ERROR_TYPE_CATALOG as any)[v.selectedType]?.description ?? null;
          errorTypeFromList = true;
        }
      } catch (error) {
        logger.warn("Failed to classify error analysis type", {
          ...formatUnknownErrorForLog(error),
          projectId: input.projectId,
          traceId: input.traceId,
          observationId: input.observationId,
        });
      }

      const rendered = {
        issue,
        ...final.data,
        errorType,
        errorTypeDescription,
        errorTypeWhy,
        errorTypeConfidence,
        errorTypeFromList,
      };

      // Save the analysis result to the database
      try {
        const errorAnalysisDelegate = (ctx.prisma as any).errorAnalysis as any;
        await errorAnalysisDelegate.upsert({
          where: {
            projectId_observationId: {
              projectId: input.projectId,
              observationId: input.observationId,
            },
          },
          create: {
            projectId: input.projectId,
            traceId: input.traceId,
            observationId: input.observationId,
            model: final.modelName,
            rootCause: final.data.rootCause,
            resolveNow: final.data.resolveNow,
            preventionNextCall: final.data.preventionNextCall,
            relevantObservations: final.data.relevantObservations,
            contextSufficient: final.data.contextSufficient,
            confidence: final.data.confidence,
            errorType,
            errorTypeDescription,
            errorTypeWhy,
            errorTypeConfidence,
            errorTypeFromList,
          },
          update: {
            model: final.modelName,
            rootCause: final.data.rootCause,
            resolveNow: final.data.resolveNow,
            preventionNextCall: final.data.preventionNextCall,
            relevantObservations: final.data.relevantObservations,
            contextSufficient: final.data.contextSufficient,
            confidence: final.data.confidence,
            errorType,
            errorTypeDescription,
            errorTypeWhy,
            errorTypeConfidence,
            errorTypeFromList,
          },
        });
      } catch (error) {
        logger.error("Failed to save error analysis to database", {
          ...formatUnknownErrorForLog(error),
          projectId: input.projectId,
          traceId: input.traceId,
          observationId: input.observationId,
        });

        // Fallback: still save the base analysis (without errorType fields).
        try {
          const errorAnalysisDelegate = (ctx.prisma as any)
            .errorAnalysis as any;
          await errorAnalysisDelegate.upsert({
            where: {
              projectId_observationId: {
                projectId: input.projectId,
                observationId: input.observationId,
              },
            },
            create: {
              projectId: input.projectId,
              traceId: input.traceId,
              observationId: input.observationId,
              model: final.modelName,
              rootCause: final.data.rootCause,
              resolveNow: final.data.resolveNow,
              preventionNextCall: final.data.preventionNextCall,
              relevantObservations: final.data.relevantObservations,
              contextSufficient: final.data.contextSufficient,
              confidence: final.data.confidence,
            },
            update: {
              model: final.modelName,
              rootCause: final.data.rootCause,
              resolveNow: final.data.resolveNow,
              preventionNextCall: final.data.preventionNextCall,
              relevantObservations: final.data.relevantObservations,
              contextSufficient: final.data.contextSufficient,
              confidence: final.data.confidence,
            },
          });
        } catch (fallbackError) {
          logger.error("Failed to save base error analysis fallback", {
            ...formatUnknownErrorForLog(fallbackError),
            projectId: input.projectId,
            traceId: input.traceId,
            observationId: input.observationId,
          });
        }
      }

      // Best-effort: sync classification into ClickHouse events tags.
      try {
        await setEventErrorTypeTag({
          projectId: input.projectId,
          spanId: input.observationId,
          errorTypeKey: errorType,
        });
      } catch (error) {
        logger.warn("Failed to sync error type tag to events table", {
          ...formatUnknownErrorForLog(error),
          projectId: input.projectId,
          traceId: input.traceId,
          observationId: input.observationId,
          errorType,
        });
      }

      return { rendered, original: final.data };
    }),

  getSummary: protectedGetTraceProcedure
    .input(
      z.object({
        projectId: z.string(),
        traceId: z.string(),
        observationId: z.string(),
      }),
    )
    .output(
      z
        .object({
          errorType: z.string().nullable(),
          errorTypeDescription: z.string().nullable(),
          errorTypeWhy: z.string().nullable(),
          errorTypeConfidence: z.number().min(0).max(1).nullable(),
          errorTypeFromList: z.boolean().nullable(),
        })
        .nullable(),
    )
    .query(async ({ input, ctx }) => {
      const delegate = (ctx.prisma as unknown as { errorAnalysis?: unknown })
        .errorAnalysis;
      if (!delegate) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Server is missing the ErrorAnalysis Prisma model. Please restart the dev server after running prisma generate/migrate.",
        });
      }

      const analysis = await ctx.prisma.errorAnalysis.findUnique({
        where: {
          projectId_observationId: {
            projectId: input.projectId,
            observationId: input.observationId,
          },
        },
      });
      if (!analysis) return null;

      return {
        errorType: (analysis as any).errorType ?? null,
        errorTypeDescription: (analysis as any).errorTypeDescription ?? null,
        errorTypeWhy: (analysis as any).errorTypeWhy ?? null,
        errorTypeConfidence: (analysis as any).errorTypeConfidence ?? null,
        errorTypeFromList: (analysis as any).errorTypeFromList ?? null,
      };
    }),

  get: protectedGetTraceProcedure
    .input(
      z.object({
        projectId: z.string(),
        traceId: z.string(),
        observationId: z.string(),
      }),
    )
    .output(ErrorAnalysisAnalyzeOutputSchema.nullable())
    .query(async ({ input, ctx }) => {
      // Access control is handled by protectedGetTraceProcedure (requires trace access)
      const delegate = (ctx.prisma as unknown as { errorAnalysis?: unknown })
        .errorAnalysis;
      if (!delegate) {
        logger.error(
          "Prisma client does not have errorAnalysis delegate (likely needs server restart after prisma generate)",
          {
            projectId: input.projectId,
            traceId: input.traceId,
            observationId: input.observationId,
          },
        );
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Server is missing the ErrorAnalysis Prisma model. Please restart the dev server after running prisma generate/migrate.",
        });
      }

      let analysis: Awaited<
        ReturnType<typeof ctx.prisma.errorAnalysis.findUnique>
      > | null = null;
      try {
        analysis = await ctx.prisma.errorAnalysis.findUnique({
          where: {
            projectId_observationId: {
              projectId: input.projectId,
              observationId: input.observationId,
            },
          },
        });
      } catch (error) {
        logger.error("Failed to load saved error analysis from database", {
          ...formatUnknownErrorForLog(error),
          projectId: input.projectId,
          traceId: input.traceId,
          observationId: input.observationId,
        });
        // Don't block the UI: treat as "no saved analysis".
        return null;
      }

      if (!analysis) return null;

      // We need to reconstruct the issue label, which depends on the observation.
      // Fetch the observation to build the label.
      // Note: We use the events table which is the primary source for observations.
      let issue = `${input.observationId} [SAVED_ANALYSIS]`;
      try {
        const observation = await getObservationByIdFromEventsTable({
          id: input.observationId,
          projectId: input.projectId,
          traceId: input.traceId,
        });
        if (observation) {
          issue = buildIssueLabel({ observation });
        }
      } catch (error) {
        logger.error(
          "Failed to load observation for saved error analysis; returning fallback issue label",
          {
            ...formatUnknownErrorForLog(error),
            projectId: input.projectId,
            traceId: input.traceId,
            observationId: input.observationId,
          },
        );
      }

      const original = {
        rootCause: analysis.rootCause,
        resolveNow: analysis.resolveNow,
        preventionNextCall: analysis.preventionNextCall,
        relevantObservations: analysis.relevantObservations,
        contextSufficient: analysis.contextSufficient,
        confidence: analysis.confidence,
      };

      const rendered = {
        issue,
        ...original,
        errorType: (analysis as any).errorType ?? null,
        errorTypeDescription: (analysis as any).errorTypeDescription ?? null,
        errorTypeWhy: (analysis as any).errorTypeWhy ?? null,
        errorTypeConfidence: (analysis as any).errorTypeConfidence ?? null,
        errorTypeFromList: (analysis as any).errorTypeFromList ?? null,
      };

      return { rendered, original };
    }),
});
