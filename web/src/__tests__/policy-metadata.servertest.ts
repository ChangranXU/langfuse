/** @jest-environment node */

import { mergeRelevantPolicyMetadata } from "@/src/features/governance/utils/policyMetadata";

describe("policyMetadata mergeRelevantPolicyMetadata", () => {
  it("merges inactivate_error_type from trace metadata when turn matches", () => {
    const merged = mergeRelevantPolicyMetadata({
      observationMetadata: {
        turn_index: 3,
      },
      traceMetadata: {
        turn_index: 3,
        inactivate_error_type:
          "DeletePolicy(inactive) hit: tool=exec | detail=delete-like pattern",
      },
      observationName: "session.output.turn_3",
      statusMessage: "normal response",
    });

    expect(merged.inactivate_error_type).toBe(
      "DeletePolicy(inactive) hit: tool=exec | detail=delete-like pattern",
    );
  });

  it("does not merge inactivate_error_type when turn and text do not match", () => {
    const merged = mergeRelevantPolicyMetadata({
      observationMetadata: {
        turn_index: 1,
      },
      traceMetadata: {
        turn_index: 2,
        inactivate_error_type:
          "DeletePolicy(inactive) hit: tool=exec | detail=delete-like pattern",
      },
      observationName: "session.output.turn_1",
      statusMessage: "different output",
    });

    expect(merged.inactivate_error_type).toBeUndefined();
  });
});
