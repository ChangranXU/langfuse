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

  it("uses normalized node ids/labels aligned with trace2 tree names", () => {
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
    expect(parserNode?.label).toBe("parser.web_search.4");
    expect(parserNode?.title).toBe(undefined);
  });

  it("avoids self-loop edges when normalized node repeats across steps", () => {
    const data: AgentGraphDataResponse[] = [
      createObservation({
        id: "turn",
        name: "session.turn.002",
        node: "session.turn.002",
        step: 1,
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:00:10.000Z",
        observationType: "CHAIN",
      }),
      createObservation({
        id: "tool",
        name: "web_fetch.3",
        node: "web_fetch.3",
        step: 2,
        startTime: "2026-01-01T00:00:01.000Z",
        endTime: "2026-01-01T00:00:01.001Z",
        observationType: "TOOL",
      }),
      createObservation({
        id: "parser-result-a",
        name: "session.parser.turn_002.tool_result.web_fetch.3",
        node: "session.parser.turn_002.tool_result.web_fetch.3",
        step: 3,
        startTime: "2026-01-01T00:00:01.100Z",
        endTime: "2026-01-01T00:00:01.101Z",
        observationType: "SPAN",
      }),
      // same normalized node at a later step
      createObservation({
        id: "parser-result-b",
        name: "session.parser.turn_002.tool_result.web_fetch.3",
        node: "session.parser.turn_002.tool_result.web_fetch.3",
        step: 4,
        startTime: "2026-01-01T00:00:01.200Z",
        endTime: "2026-01-01T00:00:01.201Z",
        observationType: "SPAN",
      }),
    ];

    const { graph } = buildGraphFromStepData(data);
    expect(graph.edges.some((e) => e.from === e.to)).toBe(false);
  });

  it("does not connect parser nodes to __end__", () => {
    const data: AgentGraphDataResponse[] = [
      createObservation({
        id: "parser-result",
        name: "session.parser.turn_002.tool_result.web_fetch.3",
        node: "session.parser.turn_002.tool_result.web_fetch.3",
        step: 1,
        observationType: "SPAN",
      }),
    ];

    const { graph } = buildGraphFromStepData(data);
    expect(graph.nodes.some((n) => n.id === "__end__")).toBe(true);
    expect(
      graph.edges.some(
        (e) => e.from === "parser.web_fetch.3" && e.to === "__end__",
      ),
    ).toBe(false);
  });

  it("only connects the global last main node to __end__", () => {
    const data: AgentGraphDataResponse[] = [
      createObservation({
        id: "turn-1",
        name: "session.turn.001",
        node: "session.turn.001",
        step: 1,
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:00:10.000Z",
        observationType: "CHAIN",
      }),
      createObservation({
        id: "a",
        name: "A - kernel.cognitive_core__respond",
        node: "A - kernel.cognitive_core__respond",
        step: 2,
        startTime: "2026-01-01T00:00:01.000Z",
        endTime: "2026-01-01T00:00:01.001Z",
        observationType: "AGENT",
      }),
      createObservation({
        id: "turn-2",
        name: "session.turn.002",
        node: "session.turn.002",
        step: 3,
        startTime: "2026-01-01T00:00:20.000Z",
        endTime: "2026-01-01T00:00:30.000Z",
        observationType: "CHAIN",
      }),
      createObservation({
        id: "b",
        name: "B - kernel.cognitive_core__respond",
        node: "B - kernel.cognitive_core__respond",
        step: 4,
        startTime: "2026-01-01T00:00:21.000Z",
        endTime: "2026-01-01T00:00:21.001Z",
        observationType: "AGENT",
      }),
    ];

    const { graph } = buildGraphFromStepData(data);
    const edgesToEnd = graph.edges.filter((e) => e.to === "__end__");
    expect(edgesToEnd).toHaveLength(1);
    expect(edgesToEnd[0]?.from).toBe("B - kernel.cognitive_core__respond");
  });

  it("parser nodes have no outgoing edges", () => {
    const data: AgentGraphDataResponse[] = [
      createObservation({
        id: "turn",
        name: "session.turn.001",
        node: "session.turn.001",
        step: 1,
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:00:10.000Z",
        observationType: "CHAIN",
      }),
      createObservation({
        id: "tool",
        name: "web_fetch.3",
        node: "web_fetch.3",
        step: 2,
        startTime: "2026-01-01T00:00:01.000Z",
        endTime: "2026-01-01T00:00:01.001Z",
        observationType: "TOOL",
      }),
      createObservation({
        id: "parser-result",
        name: "session.parser.turn_001.tool_result.web_fetch.3",
        node: "session.parser.turn_001.tool_result.web_fetch.3",
        step: 3,
        startTime: "2026-01-01T00:00:01.100Z",
        endTime: "2026-01-01T00:00:01.101Z",
        observationType: "SPAN",
      }),
    ];

    const { graph } = buildGraphFromStepData(data);
    expect(graph.edges.some((e) => e.from.startsWith("parser."))).toBe(false);
  });

  it("turn grouping uses next turn start (not turn endTime)", () => {
    const data: AgentGraphDataResponse[] = [
      createObservation({
        id: "turn-1",
        name: "session.turn.001",
        node: "session.turn.001",
        step: 1,
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:00:01.000Z", // early / unreliable
        observationType: "CHAIN",
      }),
      createObservation({
        id: "out-1",
        name: "session.output.turn_001",
        node: "session.output.turn_001",
        step: 2,
        startTime: "2026-01-01T00:00:05.000Z",
        endTime: "2026-01-01T00:00:05.001Z",
        observationType: "GENERATION",
      }),
      createObservation({
        id: "turn-2",
        name: "session.turn.002",
        node: "session.turn.002",
        step: 3,
        startTime: "2026-01-01T00:00:10.000Z",
        endTime: "2026-01-01T00:00:20.000Z",
        observationType: "CHAIN",
      }),
    ];

    const { graph } = buildGraphFromStepData(data);
    expect(
      graph.edges.some(
        (e) =>
          e.from === "session.turn.001" && e.to === "session.output.turn_001",
      ),
    ).toBe(true);
  });

  it("connects session.trace.start when present", () => {
    const data: AgentGraphDataResponse[] = [
      createObservation({
        id: "trace-start",
        name: "session.trace.start",
        node: "session.trace.start",
        step: 1,
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:00:00.001Z",
        observationType: "SPAN",
      }),
      createObservation({
        id: "turn-1",
        name: "session.turn.001",
        node: "session.turn.001",
        step: 2,
        startTime: "2026-01-01T00:00:01.000Z",
        endTime: "2026-01-01T00:00:02.000Z",
        observationType: "CHAIN",
      }),
    ];

    const { graph } = buildGraphFromStepData(data);
    expect(
      graph.edges.some(
        (e) => e.from === "__start__" && e.to === "session.trace.start",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (e) => e.from === "session.trace.start" && e.to === "session.turn.001",
      ),
    ).toBe(true);
  });

  it("numbers session.failure nodes to keep them distinct", () => {
    const data: AgentGraphDataResponse[] = [
      createObservation({
        id: "turn-1",
        name: "session.turn.001",
        node: "session.turn.001",
        step: 1,
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:00:10.000Z",
        observationType: "CHAIN",
      }),
      // Two failures that would otherwise collapse into one node name.
      createObservation({
        id: "fail-a",
        name: "session.failure",
        node: "session.turn.001", // simulate metadata pointing elsewhere
        step: 2,
        startTime: "2026-01-01T00:00:01.000Z",
        endTime: "2026-01-01T00:00:01.001Z",
        observationType: "SPAN",
        level: "ERROR",
      }),
      createObservation({
        id: "fail-b",
        name: "session.failure",
        node: "session.turn.001",
        step: 3,
        startTime: "2026-01-01T00:00:02.000Z",
        endTime: "2026-01-01T00:00:02.001Z",
        observationType: "SPAN",
        level: "ERROR",
      }),
    ];

    const { graph } = buildGraphFromStepData(data);
    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).toContain("session.failure.1");
    expect(nodeIds).toContain("session.failure.2");
  });
});
