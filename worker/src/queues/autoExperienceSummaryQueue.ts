import { Job, Processor } from "bullmq";
import { z } from "zod/v4";
import { z as zodV3 } from "zod/v3";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, isAbsolute } from "path";
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

const DEFAULT_AUTO_EXPERIENCE_SUMMARY_MIN_NEW_ANALYSES = 5;
const AutoErrorAnalysisSummarySettingsSchema = z.object({
  minNewErrorNodesForSummary: z.number().int().min(1).nullable().default(null),
  summaryAppendMarkdownAbsolutePath: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .default(null),
});

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

const HINT_SECTION_HEADING = "# HINT";
const NEXT_TOP_LEVEL_HEADING_REGEX = /^#(?!#)\s*.+$/m;

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

function resolveSummarySettings(metadata: unknown): {
  minNewErrorNodesForSummary: number;
  summaryAppendMarkdownAbsolutePath: string | null;
} {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {
      minNewErrorNodesForSummary:
        DEFAULT_AUTO_EXPERIENCE_SUMMARY_MIN_NEW_ANALYSES,
      summaryAppendMarkdownAbsolutePath: null,
    };
  }

  const parsed = AutoErrorAnalysisSummarySettingsSchema.safeParse(
    (metadata as Record<string, unknown>).autoErrorAnalysis,
  );
  if (!parsed.success) {
    return {
      minNewErrorNodesForSummary:
        DEFAULT_AUTO_EXPERIENCE_SUMMARY_MIN_NEW_ANALYSES,
      summaryAppendMarkdownAbsolutePath: null,
    };
  }

  const minNewErrorNodesForSummary =
    parsed.data.minNewErrorNodesForSummary ??
    DEFAULT_AUTO_EXPERIENCE_SUMMARY_MIN_NEW_ANALYSES;
  const pathFromSettings = parsed.data.summaryAppendMarkdownAbsolutePath;
  const validPath =
    pathFromSettings &&
    isAbsolute(pathFromSettings) &&
    pathFromSettings.toLowerCase().endsWith(".md")
      ? pathFromSettings
      : null;

  return {
    minNewErrorNodesForSummary,
    summaryAppendMarkdownAbsolutePath: validPath,
  };
}

function normalizeMarkdownLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function buildCompleteHintSectionContent(params: {
  summary: z.infer<typeof ExperienceSummaryJsonSchema>;
}) {
  const lines: string[] = [];
  lines.push(`_Last updated: ${new Date().toISOString()}_`);
  lines.push("");
  lines.push("## Prompt pack");
  lines.push(
    `- title: ${normalizeMarkdownLine(params.summary.promptPack.title)}`,
  );
  if (params.summary.promptPack.lines.length === 0) {
    lines.push("- lines:");
    lines.push("  - (none)");
  } else {
    lines.push("- lines:");
    for (const line of params.summary.promptPack.lines) {
      lines.push(`  - ${normalizeMarkdownLine(line)}`);
    }
  }
  lines.push("");
  lines.push("## Experiences");
  if (params.summary.experiences.length === 0) {
    lines.push("- (none)");
  } else {
    for (const experience of params.summary.experiences) {
      lines.push(`### ${experience.key}`);
      lines.push(`- when: ${normalizeMarkdownLine(experience.when)}`);
      lines.push(
        `- relatedErrorTypes: ${
          experience.relatedErrorTypes?.length
            ? experience.relatedErrorTypes.join(", ")
            : "n/a"
        }`,
      );
      lines.push("- possibleProblems:");
      if (experience.possibleProblems.length === 0) {
        lines.push("  - (none)");
      } else {
        for (const problem of experience.possibleProblems) {
          lines.push(`  - ${normalizeMarkdownLine(problem)}`);
        }
      }
      lines.push("- avoidanceAndNotes:");
      if (experience.avoidanceAndNotes.length === 0) {
        lines.push("  - (none)");
      } else {
        for (const note of experience.avoidanceAndNotes) {
          lines.push(`  - ${normalizeMarkdownLine(note)}`);
        }
      }
      lines.push("- promptAdditions:");
      if (experience.promptAdditions.length === 0) {
        lines.push("  - (none)");
      } else {
        for (const addition of experience.promptAdditions) {
          lines.push(`  - ${normalizeMarkdownLine(addition)}`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

function replaceHintSection(params: {
  markdown: string;
  replacementContent: string;
}) {
  const replacementSection = `${HINT_SECTION_HEADING}\n\n${params.replacementContent}\n`;
  const match = /^\s*#\s*hint\s*$/im.exec(params.markdown);
  if (!match || match.index == null) {
    if (params.markdown.trim().length === 0) return replacementSection;
    return `${params.markdown.replace(/\s*$/, "")}\n\n${replacementSection}`;
  }

  const afterHeadingIndex = params.markdown.indexOf("\n", match.index);
  const sectionContentStart =
    afterHeadingIndex === -1 ? params.markdown.length : afterHeadingIndex + 1;
  const restAfterHeading = params.markdown.slice(sectionContentStart);
  const nextTopHeadingRegex = new RegExp(
    NEXT_TOP_LEVEL_HEADING_REGEX.source,
    "gm",
  );
  let sectionEnd = sectionContentStart + restAfterHeading.length;
  let nextTopHeading: RegExpExecArray | null;
  while (
    (nextTopHeading = nextTopHeadingRegex.exec(restAfterHeading)) != null
  ) {
    const headingLine = nextTopHeading[0] ?? "";
    // If multiple "# HINT" blocks were appended over time, collapse them all
    // into a single replacement section by skipping subsequent "# HINT" headings.
    if (/^\s*#\s*hint\s*$/i.test(headingLine)) continue;
    sectionEnd = sectionContentStart + nextTopHeading.index;
    break;
  }

  const before = params.markdown.slice(0, match.index).replace(/\s*$/, "");
  const after = params.markdown.slice(sectionEnd).replace(/^\s*/, "");
  return [before, replacementSection.trimEnd(), after]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

async function replaceSummaryHintSectionInMarkdown(params: {
  absolutePath: string;
  summary: z.infer<typeof ExperienceSummaryJsonSchema>;
}) {
  await mkdir(dirname(params.absolutePath), { recursive: true });

  let existingContent = "";
  try {
    existingContent = await readFile(params.absolutePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const replacementContent = buildCompleteHintSectionContent({
    summary: params.summary,
  });
  const updatedMarkdown = replaceHintSection({
    markdown: existingContent,
    replacementContent,
  });
  await writeFile(
    params.absolutePath,
    `${updatedMarkdown.replace(/\s*$/, "")}\n`,
    "utf8",
  );
}

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
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { metadata: true },
  });
  const summarySettings = resolveSummarySettings(project?.metadata);

  const model = AutoSummaryModelSchema.catch("gpt-5.2").parse(
    job.data.payload.model ?? "gpt-5.2",
  );
  const requestedMaxItems = Math.max(
    1,
    Math.min(500, job.data.payload.maxItems ?? 50),
  );
  const maxItems = Math.max(
    summarySettings.minNewErrorNodesForSummary,
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
  if (newRows.length < summarySettings.minNewErrorNodesForSummary) return;

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
        "You are an expert at preventing recurring LLM pipeline errors. Keep output concise, practical, and focused on what can be changed in prompts for future LLM calls. Exclude implementation-heavy proposals (code/config/system changes, retries/backoff/circuit breakers, scheduler/long-running behavior changes, model/provider/account changes).\n\nWhen summarizing blocked/forbidden/unauthorized/rate-limit issues, include the specific identifiers available from newAnalyses (domain/URL/host and tool/provider/adapter) and do not invent missing details.\n\nReturn ONLY the structured JSON object that matches the provided schema.",
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
          "Make entries concise and directly useful for preventing recurrence.",
          "promptAdditions must be copy-pasteable prompt lines for the next LLM call and must be generic/reusable.",
          "Do not include hardcoded operational playbooks (e.g., fixed retry/backoff sequences, source-specific runbooks) unless the same concrete requirement is explicitly present in the analyzed failures.",
          "Do not propose actions that require code changes, infrastructure changes, or long-running behavior controls.",
          "Avoid generic blocked/forbidden advice when newAnalyses contains identifiable targets; include the domain/URL/host and tool/provider/adapter from newAnalyses when present, otherwise say unknown.",
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

  if (summarySettings.summaryAppendMarkdownAbsolutePath) {
    try {
      await replaceSummaryHintSectionInMarkdown({
        absolutePath: summarySettings.summaryAppendMarkdownAbsolutePath,
        summary: validated.data,
      });
    } catch (error) {
      logger.warn("Failed to replace summary hint section in markdown file", {
        projectId,
        path: summarySettings.summaryAppendMarkdownAbsolutePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
