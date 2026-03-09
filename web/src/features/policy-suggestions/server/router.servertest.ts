/** @jest-environment node */

import { type Observation } from "@langfuse/shared";
import {
  buildSampledTurnContext,
  parseStringArray,
  parseStringRecord,
} from "./router";

describe("policy suggestion router helpers", () => {
  it("parses policy arrays and records from mixed encodings", () => {
    expect(parseStringArray('["PolicyA","PolicyB"]')).toEqual([
      "PolicyA",
      "PolicyB",
    ]);
    expect(parseStringArray("PolicyA, PolicyB")).toEqual([
      "PolicyA",
      "PolicyB",
    ]);
    expect(parseStringRecord('{"PolicyA":"desc-a"}')).toEqual({
      PolicyA: "desc-a",
    });
  });

  it("builds sampled turn context from policy-violation turns before the confirmation turn", () => {
    const trace = {
      timestamp: new Date("2025-01-01T00:00:00.000Z"),
      input: "no",
    };

    const policyViolationObservation = {
      id: "obs-policy",
      name: "session.parser.turn_009.pre_read_file.1",
      startTime: new Date("2025-01-01T00:00:01.000Z"),
      level: "POLICY_VIOLATION",
      statusMessage:
        "POLICY_BLOCK tool=read_file reason=path not in allow_prefixes",
      input: null,
      output: null,
      metadata: {
        turn_index: "9",
        policy_names: '["HighRiskAction"]',
        policy_descriptions: '{"HighRiskAction":"Disallow unsafe actions"}',
        policy_sources: '{"HighRiskAction":"policy.md#high-risk-action"}',
        policy_protected:
          "POLICY_BLOCK tool=read_file reason=path not in allow_prefixes",
      },
    } as unknown as Observation;

    const toolCallObservation = {
      id: "obs-tool",
      name: "read_file - kernel.execution_core__tool_call @turn_009",
      startTime: new Date("2025-01-01T00:00:01.100Z"),
      level: "DEFAULT",
      statusMessage: null,
      input: '{"path":"report/week3.md"}',
      output: null,
      metadata: {
        turn_index: "9",
      },
    } as unknown as Observation;

    const confirmationTurnObservation = {
      id: "obs-confirmation",
      name: "session.output.turn_010",
      startTime: new Date("2025-01-01T00:00:02.000Z"),
      level: "ERROR",
      statusMessage: "Error: File not found: report/week3.md",
      input: "no",
      output: null,
      metadata: {
        turn_index: "10",
        policy_confirmation_state: "rejected",
      },
    } as unknown as Observation;

    const result = buildSampledTurnContext({
      policyName: "HighRiskAction",
      detail: {
        traceId: "trace-1",
        traceName: "trace-name",
        turnIndex: 10,
        nodeCount: 3,
      },
      trace,
      observations: [
        confirmationTurnObservation,
        policyViolationObservation,
        toolCallObservation,
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.turnIndex).toBe(10);
    expect(result?.policyTurnIndices).toEqual([9]);
    expect(result?.policyDescription).toBe("Disallow unsafe actions");
    expect(result?.policySource).toBe("policy.md#high-risk-action");
    expect(result?.policyProtected).toContain("allow_prefixes");
    expect(result?.relatedTurns).toHaveLength(1);
    expect(result?.relatedTurns[0]?.turnIndex).toBe(9);
    expect(result?.nodes.length).toBe(2);
    expect(result?.examplePrompt).toContain("report/week3.md");
    expect(result?.examplePrompt).not.toBe("no");
  });
});
