import { Job, Processor } from "bullmq";
import { z } from "zod/v4";
import { z as zodV3 } from "zod/v3";
import {
  ChatMessageRole,
  ChatMessageType,
  LLMAdapter,
  LLMApiKeySchema,
  type ChatMessage,
} from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import {
  fetchLLMCompletion,
  logger,
  QueueName,
  type TQueueJobTypes,
} from "@langfuse/shared/src/server";

const ExperienceSummarySchemaVersion = 1 as const;
const AutoSummaryModelSchema = z.enum(["gpt-5.2", "gpt-4.1"]);
type AutoSummaryModel = z.infer<typeof AutoSummaryModelSchema>;

const AUTO_EXPERIENCE_SUMMARY_MIN_NEW_ANALYSES = 10;

const ExperienceSummaryJsonSchema = z
  .object({
    schemaVersion: z.literal(ExperienceSummarySchemaVersion),
    experiences: z
      .array(
        z
          .object({
            key: z.string().min(1).max(64),
            when: z.string().min(1).max(800),
            possibleProblems: z.array(z.string().min(1).max(400)).max(30),
            avoidanceAndNotes: z.array(z.string().min(1).max(500)).max(40),
            promptAdditions: z.array(z.string().min(1).max(300)).max(40),
            relatedErrorTypes: z
              .array(z.string().min(1).max(64))
              .max(20)
              .nullish(),
          })
          .strict(),
      )
      .max(100),
    promptPack: z
      .object({
        title: z.string().min(1).max(120),
        lines: z.array(z.string().min(1).max(400)).max(200),
      })
      .strict(),
  })
  .strict();

const ExperienceSummaryStructuredOutputSchema = zodV3
  .object({
    schemaVersion: zodV3.literal(ExperienceSummarySchemaVersion),
    experiences: zodV3.array(
      zodV3
        .object({
          key: zodV3.string(),
          when: zodV3.string(),
          possibleProblems: zodV3.array(zodV3.string()),
          avoidanceAndNotes: zodV3.array(zodV3.string()),
          promptAdditions: zodV3.array(zodV3.string()),
          relatedErrorTypes: zodV3.array(zodV3.string()).nullable(),
        })
        .strict(),
    ),
    promptPack: zodV3
      .object({
        title: zodV3.string(),
        lines: zodV3.array(zodV3.string()),
      })
      .strict(),
  })
  .strict();

function resolveModel(model: AutoSummaryModel): string {
  return model === "gpt-5.2" ? "gpt-5.2-2025-12-11" : "gpt-4.1";
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

type ErrorAnalysisCompact = {
  observationId: string;
  traceId: string;
  updatedAt: Date;
  errorType: string | null;
  errorTypeWhy: string | null;
  rootCause: string;
  resolveNow: string[];
  preventionNextCall: string[];
  relevantObservations: string[];
  contextSufficient: boolean;
  confidence: number;
};

function compactErrorAnalysisRow(row: any): ErrorAnalysisCompact {
  return {
    observationId: String(row.observationId),
    traceId: String(row.traceId),
    updatedAt: row.updatedAt as Date,
    errorType: (row.errorType ?? null) as string | null,
    errorTypeWhy: (row.errorTypeWhy ?? null) as string | null,
    rootCause: truncateString(String(row.rootCause ?? ""), 2000),
    resolveNow: Array.isArray(row.resolveNow)
      ? (row.resolveNow as string[]).map((s) => truncateString(String(s), 400))
      : [],
    preventionNextCall: Array.isArray(row.preventionNextCall)
      ? (row.preventionNextCall as string[]).map((s) =>
          truncateString(String(s), 500),
        )
      : [],
    relevantObservations: Array.isArray(row.relevantObservations)
      ? (row.relevantObservations as string[]).map((s) => String(s))
      : [],
    contextSufficient: Boolean(row.contextSufficient ?? true),
    confidence: Number(row.confidence ?? 0.5),
  };
}

export const autoExperienceSummaryQueueProcessor: Processor = async (
  job: Job<TQueueJobTypes[QueueName.AutoExperienceSummaryQueue]>,
) => {
  const { projectId } = job.data.payload;
  const model = AutoSummaryModelSchema.catch("gpt-5.2").parse(
    job.data.payload.model ?? "gpt-5.2",
  );
  const requestedMaxItems = Math.max(
    1,
    Math.min(500, job.data.payload.maxItems ?? 50),
  );
  const maxItems = Math.max(
    AUTO_EXPERIENCE_SUMMARY_MIN_NEW_ANALYSES,
    requestedMaxItems,
  );

  const existing = await prisma.experienceSummary.findUnique({
    where: { projectId },
  });
  const cursor = existing?.cursorUpdatedAt ?? null;

  const newRows = await prisma.errorAnalysis.findMany({
    where: {
      projectId,
      ...(cursor ? { updatedAt: { gt: cursor } } : {}),
    },
    orderBy: { updatedAt: "asc" },
    take: maxItems,
  });
  if (newRows.length < AUTO_EXPERIENCE_SUMMARY_MIN_NEW_ANALYSES) return;

  const llmApiKey = await prisma.llmApiKeys.findFirst({
    where: { projectId, adapter: LLMAdapter.OpenAI },
  });
  if (!llmApiKey) {
    logger.warn(
      "Skipping auto experience summary: missing OpenAI LLM connection",
      {
        projectId,
      },
    );
    return;
  }

  const parsedKey = LLMApiKeySchema.safeParse(llmApiKey);
  if (!parsedKey.success) {
    logger.warn("Skipping auto experience summary: invalid LLM connection", {
      projectId,
      error: parsedKey.error.message,
    });
    return;
  }

  const previousSummary = existing?.summary ?? null;
  const newAnalyses = newRows.map(compactErrorAnalysisRow);

  const messages: ChatMessage[] = [
    {
      type: ChatMessageType.System,
      role: ChatMessageRole.System,
      content:
        "You are an expert at preventing recurring LLM pipeline errors. Return ONLY the structured JSON object that matches the provided schema.",
    },
    {
      type: ChatMessageType.User,
      role: ChatMessageRole.User,
      content: safeStringify({
        previousSummary,
        newAnalyses,
        instruction: [
          "Merge with previousSummary when present.",
          "Keep keys stable and snake_case; dedupe by key.",
          "Each experience item should be written as when -> possibleProblems -> avoidanceAndNotes -> promptAdditions.",
        ].join("\n"),
      }),
    },
  ];

  const modelName =
    parsedKey.data.baseURL &&
    !parsedKey.data.baseURL.includes("api.openai.com") &&
    model === "gpt-5.2"
      ? "gpt-5.2"
      : resolveModel(model);

  const raw = await fetchLLMCompletion({
    llmConnection: parsedKey.data,
    messages,
    modelParams: {
      provider: parsedKey.data.provider,
      adapter: LLMAdapter.OpenAI,
      model: modelName,
      temperature: 0.2,
      max_tokens: 8192,
    },
    streaming: false,
    structuredOutputSchema: ExperienceSummaryStructuredOutputSchema,
  });

  const validated = ExperienceSummaryJsonSchema.safeParse(raw);
  if (!validated.success) {
    logger.warn("Auto experience summary returned invalid payload", {
      projectId,
      error: validated.error.message,
    });
    return;
  }

  const maxUpdatedAt = newRows.reduce<Date>((acc, r) => {
    return r.updatedAt > acc ? r.updatedAt : acc;
  }, newRows[0]!.updatedAt);

  await prisma.experienceSummary.upsert({
    where: { projectId },
    create: {
      projectId,
      model: modelName,
      schemaVersion: validated.data.schemaVersion,
      summary: validated.data as any,
      cursorUpdatedAt: maxUpdatedAt,
    },
    update: {
      model: modelName,
      schemaVersion: validated.data.schemaVersion,
      summary: validated.data as any,
      cursorUpdatedAt: maxUpdatedAt,
    },
  });
};
