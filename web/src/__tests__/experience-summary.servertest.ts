/** @jest-environment node */

const mockFetchLLMCompletion = jest.fn();

jest.mock("@langfuse/shared/src/server", () => {
  const originalModule = jest.requireActual("@langfuse/shared/src/server");
  return {
    ...originalModule,
    fetchLLMCompletion: (...args: unknown[]) => mockFetchLLMCompletion(...args),
    logger: {
      ...originalModule.logger,
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  };
});

import type { Session } from "next-auth";
import { pruneDatabase } from "@/src/__tests__/test-utils";
import { prisma } from "@langfuse/shared/src/db";
import { appRouter } from "@/src/server/api/root";
import { createInnerTRPCContext } from "@/src/server/api/trpc";
import { LLMAdapter } from "@langfuse/shared";

describe("experienceSummary.generate RPC", () => {
  const projectId = "7a88fb47-b4e2-43b8-a06c-a5ce950dc53a";

  const session: Session = {
    expires: "1",
    user: {
      id: "user-1",
      name: "Demo User",
      canCreateOrganizations: true,
      organizations: [
        {
          id: "seed-org-id",
          role: "OWNER",
          plan: "cloud:hobby",
          cloudConfig: undefined,
          name: "Test Organization",
          metadata: {},
          projects: [
            {
              id: projectId,
              role: "ADMIN",
              name: "Test Project",
              deletedAt: null,
              retentionDays: null,
              metadata: {},
            },
          ],
        },
      ],
      featureFlags: {
        templateFlag: true,
        excludeClickhouseRead: false,
      },
      admin: true,
    },
    environment: {} as any,
  };

  const ctx = createInnerTRPCContext({ session, headers: {} });
  const caller = appRouter.createCaller({ ...ctx, prisma });

  beforeEach(async () => {
    mockFetchLLMCompletion.mockReset();
    await pruneDatabase();
    await prisma.errorAnalysis.deleteMany();
    await prisma.experienceSummary.deleteMany();
  });

  it("should reject when no OpenAI LLM connection exists", async () => {
    await prisma.errorAnalysis.create({
      data: {
        projectId,
        traceId: "trace-1",
        observationId: "obs-1",
        model: "gpt-5.2",
        rootCause: "root cause",
        resolveNow: ["step 1"],
        preventionNextCall: ["add a schema validator"],
        relevantObservations: ["obs-1"],
        contextSufficient: true,
        confidence: 0.9,
        errorType: "schema_mismatch",
        errorTypeDescription: "schema mismatch",
        errorTypeWhy: "output did not match schema",
        errorTypeConfidence: 0.8,
        errorTypeFromList: true,
      },
    });

    await expect(
      caller.experienceSummary.generate({
        projectId,
        mode: "full",
        model: "gpt-5.2",
        maxItems: 50,
      }),
    ).rejects.toThrow(/No OpenAI-adapter LLM connection configured/i);
  });

  it("should no-op for incremental update when there are no new ErrorAnalysis rows", async () => {
    await prisma.llmApiKeys.create({
      data: {
        projectId,
        provider: "openai",
        adapter: LLMAdapter.OpenAI,
        displaySecretKey: "...test",
        secretKey: "test-secret",
        baseURL: null,
        customModels: [],
        withDefaultModels: true,
        extraHeaders: null,
        extraHeaderKeys: [],
        config: null,
      },
    });

    await prisma.errorAnalysis.create({
      data: {
        projectId,
        traceId: "trace-1",
        observationId: "obs-1",
        model: "gpt-5.2",
        rootCause: "root cause",
        resolveNow: ["step 1"],
        preventionNextCall: ["add a schema validator"],
        relevantObservations: ["obs-1"],
        contextSufficient: true,
        confidence: 0.9,
        errorType: "schema_mismatch",
        errorTypeDescription: "schema mismatch",
        errorTypeWhy: "output did not match schema",
        errorTypeConfidence: 0.8,
        errorTypeFromList: true,
      },
    });

    mockFetchLLMCompletion.mockResolvedValueOnce({
      schemaVersion: 1,
      experiences: [
        {
          key: "schema_mismatch",
          when: "When structured output fails schema validation.",
          possibleProblems: ["The pipeline rejects invalid JSON/shape."],
          avoidanceAndNotes: [
            "Use strict schemas and validate before execution.",
          ],
          promptAdditions: ["Return ONLY valid JSON that matches the schema."],
          relatedErrorTypes: ["schema_mismatch"],
        },
      ],
      promptPack: {
        title: "Experience guardrails",
        lines: ["Return ONLY valid JSON matching the schema."],
      },
    });

    const first = await caller.experienceSummary.generate({
      projectId,
      mode: "full",
      model: "gpt-5.2",
      maxItems: 50,
    });

    expect(first.updated).toBe(true);
    expect(first.row?.summary.schemaVersion).toBe(1);

    const callsAfterFirst = mockFetchLLMCompletion.mock.calls.length;

    const second = await caller.experienceSummary.generate({
      projectId,
      mode: "incremental",
      model: "gpt-5.2",
      maxItems: 50,
    });

    expect(second.updated).toBe(false);
    expect(second.row?.summary.schemaVersion).toBe(1);
    expect(mockFetchLLMCompletion.mock.calls.length).toBe(callsAfterFirst);
  });

  it("should fail when LLM returns invalid structured output", async () => {
    await prisma.llmApiKeys.create({
      data: {
        projectId,
        provider: "openai",
        adapter: LLMAdapter.OpenAI,
        displaySecretKey: "...test",
        secretKey: "test-secret",
        baseURL: null,
        customModels: [],
        withDefaultModels: true,
        extraHeaders: null,
        extraHeaderKeys: [],
        config: null,
      },
    });

    await prisma.errorAnalysis.create({
      data: {
        projectId,
        traceId: "trace-1",
        observationId: "obs-1",
        model: "gpt-5.2",
        rootCause: "root cause",
        resolveNow: ["step 1"],
        preventionNextCall: ["add a schema validator"],
        relevantObservations: ["obs-1"],
        contextSufficient: true,
        confidence: 0.9,
      },
    });

    // Missing required keys -> should be rejected by schema validation
    mockFetchLLMCompletion.mockResolvedValueOnce({
      schemaVersion: 1,
      experiences: [],
    });

    await expect(
      caller.experienceSummary.generate({
        projectId,
        mode: "full",
        model: "gpt-5.2",
        maxItems: 50,
      }),
    ).rejects.toThrow(/invalid summary payload/i);
  });
});
