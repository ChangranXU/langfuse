import { buildGraphFromStepData } from "@/src/features/trace-graph-view/buildGraphCanvasData";
import {
  formatParserNodeName,
  parseParserNodeName,
} from "@/src/features/trace-graph-view/nodeNameUtils";
import { type AgentGraphDataResponse } from "@/src/features/trace-graph-view/types";

function createObservation(
  overrides: Partial<AgentGraphDataResponse> = {},
): AgentGraphDataResponse {
  return {
    id: "obs-default",
    name: "default",
    node: "default",
    step: 1,
    parentObservationId: null,
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2026-01-01T00:00:00.001Z",
    observationType: "TOOL",
    ...overrides,
  };
}

describe("parser node naming", () => {
  it("parses parser node names with turn and suffix", () => {
    const parsed = parseParserNodeName(
      "session.parser.turn_002.tool_result.web_search.4",
    );

    expect(parsed).toEqual({
      turn: 2,
      suffixSegments: ["tool_result", "web_search", "4"],
    });
  });

  it("formats parser tool result names for graph labels", () => {
    const formatted = formatParserNodeName(
      "session.parser.turn_002.tool_result.web_search.4",
      { multiline: true },
    );

    expect(formatted).toBe("Turn 2\nweb_search result #4");
  });

  it("formats parser container names for single-line header display", () => {
    const formatted = formatParserNodeName("parser.turn_002.tool_calls", {
      multiline: false,
    });

    expect(formatted).toBe("Turn 2 - Tool calls");
  });

  it("returns null for non-parser names", () => {
    expect(formatParserNodeName("regular.node.name")).toBeNull();
    expect(parseParserNodeName("regular.node.name")).toBeNull();
  });
});

describe("buildGraphFromStepData parser pruning", () => {
  it("prunes redundant parser container nodes when detailed nodes exist", () => {
    const data: AgentGraphDataResponse[] = [
      createObservation({
        id: "container",
        name: "container",
        node: "session.parser.turn_002.tool_calls",
        step: 1,
      }),
      createObservation({
        id: "call",
        name: "call",
        node: "session.parser.turn_002.tool_call.web_search.4",
        step: 2,
      }),
      createObservation({
        id: "result",
        name: "result",
        node: "session.parser.turn_002.tool_result.web_search.4",
        step: 3,
      }),
    ];

    const { graph, nodeToObservationsMap } = buildGraphFromStepData(data);
    const nodeIds = graph.nodes.map((n) => n.id);

    expect(nodeIds).toContain("parser.turn_002.tool_call.web_search.4");
    expect(nodeIds).toContain("parser.web_search.4");
    expect(nodeIds).not.toContain("parser.turn_002.tool_calls");
    expect(nodeToObservationsMap["parser.turn_002.tool_calls"]).toBe(undefined);
  });

  it("prunes parser container nodes even when no detailed nodes exist", () => {
    const data: AgentGraphDataResponse[] = [
      createObservation({
        id: "container",
        name: "container",
        node: "session.parser.turn_002.tool_calls",
        step: 1,
      }),
    ];

    const { graph } = buildGraphFromStepData(data);
    const nodeIds = graph.nodes.map((n) => n.id);

    expect(nodeIds).not.toContain("parser.turn_002.tool_calls");
  });

  it("uses readable parser labels and raw-name title tooltip", () => {
    const data: AgentGraphDataResponse[] = [
      createObservation({
        id: "result",
        name: "result",
        node: "session.parser.turn_002.tool_result.web_search.4",
        step: 1,
      }),
    ];

    const { graph } = buildGraphFromStepData(data);
    const parserNode = graph.nodes.find((n) => n.id === "parser.web_search.4");

    expect(parserNode).toBeDefined();
    expect(parserNode?.label).toBe("Turn 2\nweb_search result #4");
    expect(parserNode?.title).toBe(
      "session.parser.turn_002.tool_result.web_search.4",
    );
  });
});
