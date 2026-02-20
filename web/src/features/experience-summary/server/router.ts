import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, isAbsolute } from "path";
import {
  protectedProjectProcedure,
  createTRPCRouter,
} from "@/src/server/api/trpc";
import { throwIfNoProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import {
  ChatMessageRole,
  ChatMessageType,
  LLMAdapter,
  LLMApiKeySchema,
  type ChatMessage,
} from "@langfuse/shared";
import { fetchLLMCompletion, logger } from "@langfuse/shared/src/server";
import {
  ExperienceSummaryJsonSchema,
  ExperienceSummaryModeSchema,
  ExperienceSummaryModelSchema,
  ExperienceSummaryStructuredOutputSchema,
} from "../types";

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

function resolveDemoOpenAIModel(
  model: z.infer<typeof ExperienceSummaryModelSchema>,
) {
  return model === "gpt-5.2" ? "gpt-5.2-2025-12-11" : "gpt-4.1";
}

const AutoErrorAnalysisSummarySettingsSchema = z.object({
  summaryAppendMarkdownAbsolutePath: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .default(null),
});

const HINT_SECTION_HEADING = "# HINT";
const NEXT_TOP_LEVEL_HEADING_REGEX = /^#(?!#)\s*.+$/m;

const ExperienceSummaryGetInputSchema = z.object({
  projectId: z.string(),
});

const ExperienceSummaryIncrementalUpdateStatusSchema = z.object({
  cursorUpdatedAt: z.date().nullable(),
  pendingAnalysesCount: z.number().int().min(0),
});

const ExperienceSummaryRowSchema = z.object({
  projectId: z.string(),
  model: z.string(),
  schemaVersion: z.number().int().positive(),
  summary: ExperienceSummaryJsonSchema,
  cursorUpdatedAt: z.date().nullable(),
  updatedAt: z.date(),
});

const ExperienceSummaryGenerateInputSchema = z.object({
  projectId: z.string(),
  mode: ExperienceSummaryModeSchema.default("incremental"),
  model: ExperienceSummaryModelSchema.default("gpt-5.2"),
  maxItems: z.number().int().positive().max(500).default(50),
});

const ExperienceSummaryGenerateOutputSchema = z.object({
  updated: z.boolean(),
  row: ExperienceSummaryRowSchema.nullable(),
});

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

function resolveSummaryMarkdownPath(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const parsed = AutoErrorAnalysisSummarySettingsSchema.safeParse(
    (metadata as Record<string, unknown>).autoErrorAnalysis,
  );
  if (!parsed.success) return null;

  const pathFromSettings = parsed.data.summaryAppendMarkdownAbsolutePath;
  if (
    !pathFromSettings ||
    !isAbsolute(pathFromSettings) ||
    !pathFromSettings.toLowerCase().endsWith(".md")
  ) {
    return null;
  }

  return pathFromSettings;
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
    rootCause: truncateString(String(row.rootCause ?? ""), 2_000),
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

function buildUserPayload(params: {
  previousSummary: unknown | null;
  newAnalyses: ErrorAnalysisCompact[];
}) {
  return {
    previousSummary: params.previousSummary,
    newAnalyses: params.newAnalyses,
    instruction: [
      "You are creating an 'experience summary' to reduce recurrence of LLM pipeline errors/warnings.",
      "You MUST output ONLY the JSON object that matches the provided schema.",
      "Merge with previousSummary when present. Keep keys stable and snake_case; dedupe by key.",
      "Each experience item should be written as: when -> possibleProblems -> avoidanceAndNotes -> promptAdditions.",
      "Keep entries concise and directly useful for preventing recurrence.",
      "promptAdditions should be directly pasteable lines for a user's prompt (guardrails/checklist), and should be generic/reusable.",
      "Prefer actionable, specific, and generalizable advice over vague statements.",
      "Exclude non-prompt or implementation-heavy suggestions: code/config/system changes, retries/backoff/circuit breakers, scheduler or long-running behavior changes, model/provider/account changes.",
      "Avoid hardcoded operational playbooks unless explicitly required by repeated evidence in newAnalyses.",
      "For blocked/forbidden/unauthorized/rate-limit cases, include the identifiable target (domain/URL/host) and tool/provider/adapter from newAnalyses when present; do not fabricate missing identifiers (use unknown).",
    ].join("\n"),
  };
}

export const experienceSummaryRouter = createTRPCRouter({
  get: protectedProjectProcedure
    .input(ExperienceSummaryGetInputSchema)
    .output(ExperienceSummaryRowSchema.nullable())
    .query(async ({ input, ctx }) => {
      const delegate = (ctx.prisma as any).experienceSummary as
        | typeof ctx.prisma.experienceSummary
        | undefined;
      if (!delegate) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Server is missing the ExperienceSummary Prisma model. Please restart the dev server after running prisma generate/migrate.",
        });
      }

      const row = await ctx.prisma.experienceSummary.findUnique({
        where: { projectId: input.projectId },
      });
      if (!row) return null;

      const parsed = ExperienceSummaryJsonSchema.safeParse(row.summary);
      if (!parsed.success) {
        logger.warn("Stored experience summary failed schema validation", {
          projectId: input.projectId,
          error: parsed.error.message,
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Stored experience summary is invalid (schema mismatch).",
        });
      }

      return {
        projectId: row.projectId,
        model: row.model,
        schemaVersion: row.schemaVersion,
        summary: parsed.data,
        cursorUpdatedAt: row.cursorUpdatedAt,
        updatedAt: row.updatedAt,
      };
    }),

  getIncrementalUpdateStatus: protectedProjectProcedure
    .input(ExperienceSummaryGetInputSchema)
    .output(ExperienceSummaryIncrementalUpdateStatusSchema)
    .query(async ({ input, ctx }) => {
      const existing = await ctx.prisma.experienceSummary.findUnique({
        where: { projectId: input.projectId },
        select: { cursorUpdatedAt: true },
      });

      const cursorUpdatedAt = existing?.cursorUpdatedAt ?? null;
      const pendingAnalysesCount = await ctx.prisma.errorAnalysis.count({
        where: {
          projectId: input.projectId,
          ...(cursorUpdatedAt ? { updatedAt: { gt: cursorUpdatedAt } } : {}),
        },
      });

      return {
        cursorUpdatedAt,
        pendingAnalysesCount,
      };
    }),

  generate: protectedProjectProcedure
    .input(ExperienceSummaryGenerateInputSchema)
    .output(ExperienceSummaryGenerateOutputSchema)
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "llmApiKeys:read",
        forbiddenErrorMessage:
          "User does not have access to run LLM analysis (missing llmApiKeys:read).",
      });

      const delegate = (ctx.prisma as any).experienceSummary as
        | typeof ctx.prisma.experienceSummary
        | undefined;
      if (!delegate) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Server is missing the ExperienceSummary Prisma model. Please restart the dev server after running prisma generate/migrate.",
        });
      }

      const existing = await ctx.prisma.experienceSummary.findUnique({
        where: { projectId: input.projectId },
      });

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
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not parse LLM connection configuration.",
        });
      }

      const cursor =
        input.mode === "incremental"
          ? (existing?.cursorUpdatedAt ?? null)
          : null;

      const newRows = await ctx.prisma.errorAnalysis.findMany({
        where: {
          projectId: input.projectId,
          ...(cursor ? { updatedAt: { gt: cursor } } : {}),
        },
        orderBy: { updatedAt: "asc" },
        take: input.maxItems,
      });

      if (input.mode === "incremental" && existing && newRows.length === 0) {
        const parsed = ExperienceSummaryJsonSchema.safeParse(existing.summary);
        if (!parsed.success) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Stored experience summary is invalid (schema mismatch).",
          });
        }
        return {
          updated: false,
          row: {
            projectId: existing.projectId,
            model: existing.model,
            schemaVersion: existing.schemaVersion,
            summary: parsed.data,
            cursorUpdatedAt: existing.cursorUpdatedAt,
            updatedAt: existing.updatedAt,
          },
        };
      }

      if (!existing && newRows.length === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "No ErrorAnalysis records found yet. Run Analyze on some ERROR/WARNING observations first.",
        });
      }

      const previousSummary = existing?.summary ?? null;
      const newAnalyses = newRows.map(compactErrorAnalysisRow);

      const messages: ChatMessage[] = [
        {
          type: ChatMessageType.System,
          role: ChatMessageRole.System,
          content:
            "You are an expert at preventing recurring LLM pipeline errors. Keep output concise and focused on what can be changed in prompts for future LLM calls. Exclude implementation-heavy proposals (code/config/system changes, retries/backoff/circuit breakers, scheduler/long-running behavior changes, model/provider/account changes). Return ONLY the structured JSON object that matches the provided schema.",
        },
        {
          type: ChatMessageType.User,
          role: ChatMessageRole.User,
          content: safeStringify(
            buildUserPayload({
              previousSummary,
              newAnalyses,
            }),
          ),
        },
      ];

      const modelName =
        parsedKey.data.baseURL &&
        !parsedKey.data.baseURL.includes("api.openai.com") &&
        input.model === "gpt-5.2"
          ? "gpt-5.2"
          : resolveDemoOpenAIModel(input.model);

      let raw: unknown;
      try {
        raw = await fetchLLMCompletion({
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
      } catch (e) {
        logger.warn("Experience summary LLM request failed", {
          projectId: input.projectId,
          message: e instanceof Error ? e.message : String(e),
        });
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "LLM request failed while generating experience summary. Check Settings → LLM Connections and retry.",
        });
      }

      const validated = ExperienceSummaryJsonSchema.safeParse(raw);
      if (!validated.success) {
        logger.warn(
          "LLM returned invalid structured output for experience summary",
          {
            projectId: input.projectId,
            error: validated.error.message,
          },
        );
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "LLM returned an invalid summary payload (not matching expected schema). " +
            validated.error.message,
        });
      }

      const maxUpdatedAt =
        newRows.length > 0
          ? newRows.reduce<Date>((acc, r) => {
              const t = r.updatedAt;
              return t > acc ? t : acc;
            }, newRows[0]!.updatedAt)
          : (existing?.cursorUpdatedAt ?? null);

      const saved = await ctx.prisma.experienceSummary.upsert({
        where: { projectId: input.projectId },
        create: {
          projectId: input.projectId,
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

      const projectForSettings = await ctx.prisma.project.findUnique({
        where: { id: input.projectId },
        select: { metadata: true },
      });
      const summaryMarkdownPath = resolveSummaryMarkdownPath(
        projectForSettings?.metadata,
      );
      if (summaryMarkdownPath) {
        try {
          await replaceSummaryHintSectionInMarkdown({
            absolutePath: summaryMarkdownPath,
            summary: validated.data,
          });
        } catch (error) {
          logger.warn(
            "Failed to replace summary hint section in markdown file",
            {
              projectId: input.projectId,
              path: summaryMarkdownPath,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }

      return {
        updated: true,
        row: {
          projectId: saved.projectId,
          model: saved.model,
          schemaVersion: saved.schemaVersion,
          summary: validated.data,
          cursorUpdatedAt: saved.cursorUpdatedAt,
          updatedAt: saved.updatedAt,
        },
      };
    }),
});
