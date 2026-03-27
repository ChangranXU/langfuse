/** @jest-environment node */

import {
  getHumanPolicyConfirmationState,
  hasHumanPolicyConfirmationReply,
} from "./policyConfirmation";

describe("policy confirmation helpers", () => {
  it("detects compact yes/no replies from direct and nested payloads", () => {
    expect(
      hasHumanPolicyConfirmationReply({
        observationInput: '"yes"',
      }),
    ).toBe(true);
    expect(
      hasHumanPolicyConfirmationReply({
        traceInput: '{"raw_content":"{\\"content\\":\\"no\\"}"}',
      }),
    ).toBe(true);
    expect(
      hasHumanPolicyConfirmationReply({
        traceMetadata: { text_preview: "no" },
      }),
    ).toBe(true);
  });

  it("ignores longer policy-violation prompts that mention yes/no", () => {
    expect(
      hasHumanPolicyConfirmationReply({
        traceInput:
          '{"content":"policy violation detected, do you want to apply the protection? Please reply Yes/No."}',
      }),
    ).toBe(false);
  });

  it("only returns human confirmation states for accepted or rejected yes/no turns", () => {
    expect(
      getHumanPolicyConfirmationState({
        metadata: { policy_confirmation_state: "accepted" },
        traceInput: '{"content":"yes"}',
      }),
    ).toBe("accepted");
    expect(
      getHumanPolicyConfirmationState({
        metadata: { policy_confirmation_state: "rejected" },
        traceInput: '{"content":"continue with the deletion"}',
      }),
    ).toBeNull();
    expect(
      getHumanPolicyConfirmationState({
        metadata: { policy_confirmation_state: "rejected" },
        traceMetadata: { text_preview: "no" },
        traceInput:
          '{"content":"two reads are consistent; here is the weekly summary"}',
      }),
    ).toBe("rejected");
    expect(
      getHumanPolicyConfirmationState({
        metadata: { policy_confirmation_state: "ask" },
        traceInput: '{"content":"yes"}',
      }),
    ).toBeNull();
  });
});
