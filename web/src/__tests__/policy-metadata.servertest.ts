/** @jest-environment node */

import { mergeRelevantPolicyMetadata } from "@/src/features/governance/utils/policyMetadata";
import {
  getGovernanceDisplayLevel,
  getInactivateErrorTypeDisplayLabel,
  getRelevantInactivateErrorType,
} from "@/src/features/governance/utils/policyMetadata";

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

  it("treats matching inactivate_error_type as a warning display level", () => {
    const level = getGovernanceDisplayLevel({
      level: "ERROR",
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

    expect(level).toBe("WARNING");
  });

  it("extracts the relevant inactivate_error_type from matching trace metadata", () => {
    const value = getRelevantInactivateErrorType({
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

    expect(value).toBe(
      "DeletePolicy(inactive) hit: tool=exec | detail=delete-like pattern",
    );
  });

  it("builds a compact display label for inactivate_error_type", () => {
    expect(
      getInactivateErrorTypeDisplayLabel(
        "DeletePolicy(inactive) hit: tool=exec | detail=delete-like pattern matched but remained non-blocking",
      ),
    ).toBe("DeletePolicy(inactive)");
  });
});
