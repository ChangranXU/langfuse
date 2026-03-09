import { z } from "zod/v4";
import { z as zodV3 } from "zod/v3";
import { ErrorAnalysisModelSchema } from "@/src/features/error-analysis/types";

export const PolicySuggestionModelSchema = ErrorAnalysisModelSchema;
export type PolicySuggestionModel = z.infer<typeof PolicySuggestionModelSchema>;

export const PolicySuggestionResultSchema = z.object({
  suggestion: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  supportingSignals: z.array(z.string()).default([]),
});
export type PolicySuggestionResult = z.infer<
  typeof PolicySuggestionResultSchema
>;

export const PolicySuggestionGenerateOutputSchema = z.object({
  policyName: z.string(),
  suggestion: PolicySuggestionResultSchema,
  sampledRejectedTurns: z.number().int().min(0),
});
export type PolicySuggestionGenerateOutput = z.infer<
  typeof PolicySuggestionGenerateOutputSchema
>;

export const PolicySuggestionStructuredOutputSchema = zodV3.object({
  suggestion: zodV3
    .string()
    .describe(
      "1-2 concise lines suggesting how to modify the policy rule, scope, allowlist/denylist logic, or policy wording itself to reduce false rejections while staying safe. Do not suggest changes to UI copy, confirmation prompts, or generic error-message phrasing.",
    ),
  reason: zodV3
    .string()
    .describe(
      "2-3 concise lines explaining why this policy-level change fits the observed rejected policy confirmations and enforcement signals. Focus on how the policy itself is too broad, too narrow, ambiguous, or incorrectly scoped; do not justify message-copy or UX wording changes.",
    ),
  supportingSignals: zodV3
    .array(zodV3.string())
    .describe(
      "Optional short evidence bullets from the provided examples (policy block reasons, repeated prompts, recurring nodes).",
    )
    .optional(),
});
