import {
  type GraphCanvasData,
  type GraphNodeData,
  type AgentGraphDataResponse,
  LANGGRAPH_START_NODE_NAME,
  LANGGRAPH_END_NODE_NAME,
  LANGFUSE_START_NODE_NAME,
  LANGFUSE_END_NODE_NAME,
} from "./types";
import {
  normalizeParserNodeNameForGraph,
  normalizeToolResultNodeName,
  parseParserNodeName,
} from "./nodeNameUtils";

export interface GraphParseResult {
  graph: GraphCanvasData;
  nodeToObservationsMap: Record<string, string[]>;
}

export function transformLanggraphToGeneralized(
  data: AgentGraphDataResponse[],
): AgentGraphDataResponse[] {
  // can't draw nodes without `node` property set for LangGraph
  const filteredData = data.filter(
    (obs) => obs.node && obs.node.trim().length > 0,
  );

  const transformedData = filteredData.map((obs) => {
    const normalizedNodeName =
      normalizeToolResultNodeName(obs.node || obs.name) || obs.name;
    let transformedObs = {
      ...obs,
      // fallback to node name if node empty (shouldn't happen!)
      name: normalizedNodeName,
      node: obs.node ? normalizeToolResultNodeName(obs.node) || obs.node : null,
    };

    // Transform system nodes to Langfuse system nodes
    if (obs.node === LANGGRAPH_START_NODE_NAME) {
      transformedObs.name = LANGFUSE_START_NODE_NAME;
      transformedObs.id = LANGFUSE_START_NODE_NAME;
    } else if (obs.node === LANGGRAPH_END_NODE_NAME) {
      transformedObs.name = LANGFUSE_END_NODE_NAME;
      transformedObs.id = LANGFUSE_END_NODE_NAME;
    }

    return transformedObs;
  });

  // Add Langfuse system nodes if they don't exist
  const hasStartNode = transformedData.some(
    (obs) => obs.name === LANGFUSE_START_NODE_NAME,
  );
  const hasEndNode = transformedData.some(
    (obs) => obs.name === LANGFUSE_END_NODE_NAME,
  );

  const systemNodes: AgentGraphDataResponse[] = [];

  if (!hasStartNode) {
    // Find the top-level parent for system node mapping
    const topLevelObs = transformedData.find((obs) => !obs.parentObservationId);
    systemNodes.push({
      id: LANGFUSE_START_NODE_NAME,
      name: LANGFUSE_START_NODE_NAME,
      node: LANGFUSE_START_NODE_NAME,
      step: 0,
      parentObservationId: topLevelObs?.parentObservationId || null,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      observationType: "LANGGRAPH_SYSTEM",
    });
  }

  if (!hasEndNode) {
    const topLevelObs = transformedData.find((obs) => !obs.parentObservationId);
    const maxStep = Math.max(...transformedData.map((obs) => obs.step || 0));
    systemNodes.push({
      id: LANGFUSE_END_NODE_NAME,
      name: LANGFUSE_END_NODE_NAME,
      node: LANGFUSE_END_NODE_NAME,
      step: maxStep + 1,
      parentObservationId: topLevelObs?.parentObservationId || null,
      startTime: new Date().toISOString(),
      endTime: new Date().toISOString(),
      observationType: "LANGGRAPH_SYSTEM",
    });
  }

  return [...transformedData, ...systemNodes];
}

export function buildGraphFromStepData(
  data: AgentGraphDataResponse[],
): GraphParseResult {
  if (data.length === 0) {
    return {
      graph: { nodes: [], edges: [] },
      nodeToObservationsMap: {},
    };
  }

  // Give session.failure nodes stable unique names for graph display/mapping.
  // This avoids collapsing multiple failures into one node, and ensures failures
  // show up even if metadata-based agent_graph_node points elsewhere.
  const failureNodeNameByObservationId = new Map<string, string>();
  const failureObservations = [...data]
    .filter((o) => o.name === "session.failure")
    .sort((a, b) => {
      const t =
        new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
      if (t !== 0) return t;
      return a.id.localeCompare(b.id);
    });
  failureObservations.forEach((o, idx) => {
    failureNodeNameByObservationId.set(o.id, `session.failure.${idx + 1}`);
  });

  const getEffectiveRawNodeName = (
    obs: AgentGraphDataResponse,
  ): string | null => {
    const overriddenFailure = failureNodeNameByObservationId.get(obs.id);
    if (overriddenFailure) {
      return overriddenFailure;
    }
    return obs.node;
  };

  const stepToNodesMap = new Map<number, Set<string>>();
  const nodeToObservationsMap = new Map<string, string[]>();

  data.forEach((obs) => {
    const step = obs.step;
    const node = getEffectiveRawNodeName(obs);

    if (step !== null && node !== null) {
      if (!stepToNodesMap.has(step)) {
        stepToNodesMap.set(step, new Set());
      }
      stepToNodesMap.get(step)!.add(node);
    }

    if (node !== null) {
      const isSystemNode =
        node === LANGFUSE_START_NODE_NAME ||
        node === LANGFUSE_END_NODE_NAME ||
        node === LANGGRAPH_START_NODE_NAME ||
        node === LANGGRAPH_END_NODE_NAME;

      if (!isSystemNode) {
        if (!nodeToObservationsMap.has(node)) {
          nodeToObservationsMap.set(node, []);
        }
        nodeToObservationsMap.get(node)!.push(obs.id);
      }
    }
  });

  const parserNodesToPrune = getRedundantParserNodes(stepToNodesMap);
  if (parserNodesToPrune.size > 0) {
    for (const [step, nodesAtStep] of stepToNodesMap.entries()) {
      const remainingNodes = new Set(
        Array.from(nodesAtStep).filter((node) => !parserNodesToPrune.has(node)),
      );

      if (remainingNodes.size === 0) {
        stepToNodesMap.delete(step);
      } else {
        stepToNodesMap.set(step, remainingNodes);
      }
    }

    parserNodesToPrune.forEach((nodeName) => {
      nodeToObservationsMap.delete(nodeName);
    });
  }

  // Normalize internal parser node names for graph display (ids/edges/map keys),
  // while ensuring each normalized node appears only once in the hierarchy.
  const normalizedToRawNodeName = new Map<string, string>();
  const normalizedNodeToMinStep = new Map<string, number>();
  for (const [step, nodesAtStep] of stepToNodesMap.entries()) {
    for (const rawNodeName of nodesAtStep) {
      const normalizedNodeName =
        normalizeParserNodeNameForGraph(rawNodeName) ?? rawNodeName;
      const existing = normalizedNodeToMinStep.get(normalizedNodeName);
      if (existing === undefined || step < existing) {
        normalizedNodeToMinStep.set(normalizedNodeName, step);
      }
      if (!normalizedToRawNodeName.has(normalizedNodeName)) {
        normalizedToRawNodeName.set(normalizedNodeName, rawNodeName);
      }
    }
  }

  const normalizedStepToNodesMap = new Map<number, Set<string>>();
  for (const [normalizedNodeName, step] of normalizedNodeToMinStep.entries()) {
    if (!normalizedStepToNodesMap.has(step)) {
      normalizedStepToNodesMap.set(step, new Set());
    }
    normalizedStepToNodesMap.get(step)!.add(normalizedNodeName);
  }

  const normalizedNodeToObservationsMap = new Map<string, string[]>();
  for (const [rawNodeName, observationIds] of nodeToObservationsMap.entries()) {
    const normalizedNodeName =
      normalizeParserNodeNameForGraph(rawNodeName) ?? rawNodeName;
    const existing = normalizedNodeToObservationsMap.get(normalizedNodeName);
    if (existing) {
      existing.push(...observationIds);
    } else {
      normalizedNodeToObservationsMap.set(normalizedNodeName, [
        ...observationIds,
      ]);
    }
    if (!normalizedToRawNodeName.has(normalizedNodeName)) {
      normalizedToRawNodeName.set(normalizedNodeName, rawNodeName);
    }
  }

  // Build nodes from step mapping
  const nodeNames = [
    ...new Set([
      LANGFUSE_START_NODE_NAME,
      ...Array.from(normalizedNodeToObservationsMap.keys()),
      LANGFUSE_END_NODE_NAME,
    ]),
  ];

  const dataById = new Map(data.map((o) => [o.id, o]));

  const nodes: GraphNodeData[] = nodeNames.map((nodeName) => {
    if (
      nodeName === LANGFUSE_END_NODE_NAME ||
      nodeName === LANGFUSE_START_NODE_NAME
    ) {
      return {
        id: nodeName,
        label: nodeName,
        type: "LANGGRAPH_SYSTEM",
        level: null,
      };
    }
    const isParserNode = nodeName.startsWith("parser.");
    const obsIds = normalizedNodeToObservationsMap.get(nodeName) ?? [];
    const observations = obsIds.map((id) => dataById.get(id)).filter(Boolean);
    const obs = observations[0];

    const severityRank = (level?: string | null) => {
      if (level === "ERROR") return 3;
      if (level === "WARNING") return 2;
      if (level === "DEFAULT") return 1;
      if (level === "DEBUG") return 0;
      return -1;
    };
    const nodeLevel =
      observations
        .map((o) => o?.level)
        .sort((a, b) => severityRank(b) - severityRank(a))[0] ?? null;

    const firstErrorStatus =
      observations.find((o) => o?.level === "ERROR")?.statusMessage ??
      observations.find((o) => o?.level === "WARNING")?.statusMessage ??
      null;
    return {
      id: nodeName,
      label: nodeName,
      type: isParserNode ? "PARSER" : obs?.observationType || "UNKNOWN",
      title: firstErrorStatus ?? undefined,
      level: nodeLevel,
    };
  });

  // Compute UI-aligned parent relationships to avoid "self edges" and keep the graph
  // consistent with the trace2 tree (node names + parent-child expectations).
  const forcedParentByNodeName = new Map<string, string>();
  const nodeExists = (name: string) =>
    normalizedNodeToObservationsMap.has(name);

  const obsChrono = data
    .filter((o) => o.step !== null)
    .filter((o) => {
      const rawNodeName = getEffectiveRawNodeName(o);
      return rawNodeName ? !parserNodesToPrune.has(rawNodeName) : false;
    })
    .map((o) => {
      const rawNodeName = getEffectiveRawNodeName(o)!;
      const normalizedNodeName =
        normalizeParserNodeNameForGraph(rawNodeName) ?? rawNodeName;
      return {
        name: o.name,
        normalizedNodeName,
        startMs: new Date(o.startTime).getTime(),
        endMs: o.endTime ? new Date(o.endTime).getTime() : null,
      };
    })
    .sort((a, b) => a.startMs - b.startMs);

  const SESSION_TURN_NODE_RE = /^session\.turn\.(?<turn>\d+)$/;
  const sessionTurns = obsChrono
    .map((o) => {
      if (!SESSION_TURN_NODE_RE.test(o.normalizedNodeName)) return null;
      return {
        nodeName: o.normalizedNodeName,
        start: o.startMs,
        end: o.endMs,
      };
    })
    .filter((t) => t !== null)
    .sort((a, b) => a.start - b.start);

  const sessionTurnEndBounds = sessionTurns.map((turn, idx) => {
    // Turns often have an endTime earlier than their last "logical" children.
    // For graph readability/alignment, prefer the next turn's start as the boundary.
    const next = sessionTurns[idx + 1];
    return next ? next.start : Number.POSITIVE_INFINITY;
  });

  const TOOL_RESULT_UI_NODE_RE = /^parser\.(?<toolName>[^.]+)\.(?<index>\d+)$/;
  const STRUCTURED_OUTPUT_UI_NODE_RE = /^parser\.turn_\d+\.structured_output$/;

  let latestKernelNodeName: string | null = null;
  let activeTurnIndex = 0;

  for (const o of obsChrono) {
    // Group non-parser nodes under session.turn.xxx (node-level).
    while (
      activeTurnIndex < sessionTurns.length &&
      o.startMs >= sessionTurnEndBounds[activeTurnIndex]!
    ) {
      activeTurnIndex++;
    }
    const activeTurn = sessionTurns[activeTurnIndex];
    const activeTurnEndBound = sessionTurnEndBounds[activeTurnIndex];
    if (
      activeTurn &&
      o.normalizedNodeName !== activeTurn.nodeName &&
      !o.normalizedNodeName.startsWith("parser.") &&
      o.startMs >= activeTurn.start &&
      o.startMs < (activeTurnEndBound ?? Number.POSITIVE_INFINITY) &&
      nodeExists(activeTurn.nodeName) &&
      nodeExists(o.normalizedNodeName) &&
      !forcedParentByNodeName.has(o.normalizedNodeName)
    ) {
      forcedParentByNodeName.set(o.normalizedNodeName, activeTurn.nodeName);
    }

    // Attach parser tool_result nodes under tool_name.{n}
    const toolResultMatch = TOOL_RESULT_UI_NODE_RE.exec(o.normalizedNodeName);
    if (toolResultMatch?.groups?.toolName && toolResultMatch.groups.index) {
      const targetParentName = `${toolResultMatch.groups.toolName}.${toolResultMatch.groups.index}`;
      if (nodeExists(o.normalizedNodeName) && nodeExists(targetParentName)) {
        forcedParentByNodeName.set(o.normalizedNodeName, targetParentName);
      }
    }

    // Track kernel nodes (topic - kernel.xxx)
    if (typeof o.name === "string" && o.name.includes(" - kernel.")) {
      if (nodeExists(o.normalizedNodeName)) {
        latestKernelNodeName = o.normalizedNodeName;
      }
    }

    // Attach structured_output nodes under latest kernel node
    if (
      STRUCTURED_OUTPUT_UI_NODE_RE.test(o.normalizedNodeName) &&
      latestKernelNodeName &&
      nodeExists(o.normalizedNodeName) &&
      nodeExists(latestKernelNodeName)
    ) {
      forcedParentByNodeName.set(o.normalizedNodeName, latestKernelNodeName);
    }
  }

  const edgesSet = new Set<string>();
  const addEdge = (from: string, to: string) => {
    if (!from || !to || from === to) return;
    if (to === LANGFUSE_START_NODE_NAME) return;
    if (from === LANGFUSE_END_NODE_NAME) return;
    // Parser-related nodes are UI-details; never allow outgoing edges from them.
    if (from.startsWith("parser.")) return;
    edgesSet.add(`${from}→${to}`);
  };

  // If we have session turn nodes, build a clean, readable graph aligned with the
  // trace2 tree expectations:
  // - A single main chain of non-parser nodes per turn (ordered by time)
  // - Parser nodes are leaf details (incoming edges only, no outgoing edges)
  // - Only the global last main-chain node connects to __end__
  if (sessionTurns.length > 0) {
    const byTurnNodeName = new Map<
      string,
      Map<string, { firstStartMs: number }>
    >();
    sessionTurns.forEach((t) => {
      byTurnNodeName.set(
        t.nodeName,
        new Map([[t.nodeName, { firstStartMs: t.start }]]),
      );
    });

    // Track latest kernel node per turn window for structured_output attachment.
    const latestKernelByTurn = new Map<string, string>();
    let activeIdx = 0;
    for (const o of obsChrono) {
      while (
        activeIdx < sessionTurns.length &&
        o.startMs >= sessionTurnEndBounds[activeIdx]!
      ) {
        activeIdx++;
      }
      const activeTurn = sessionTurns[activeIdx];
      const activeTurnEndBound = sessionTurnEndBounds[activeIdx];
      if (
        !activeTurn ||
        o.startMs < activeTurn.start ||
        o.startMs >= (activeTurnEndBound ?? Number.POSITIVE_INFINITY)
      ) {
        continue;
      }

      // Record kernel nodes for this turn.
      if (typeof o.name === "string" && o.name.includes(" - kernel.")) {
        latestKernelByTurn.set(activeTurn.nodeName, o.normalizedNodeName);
      }

      // Build per-turn main-chain candidate nodes (non-parser only).
      if (
        !o.normalizedNodeName.startsWith("parser.") &&
        nodeExists(o.normalizedNodeName)
      ) {
        const map = byTurnNodeName.get(activeTurn.nodeName);
        if (map && !map.has(o.normalizedNodeName)) {
          map.set(o.normalizedNodeName, { firstStartMs: o.startMs });
        }
      }
    }

    // Create main chain edges per turn.
    const turnChains: Array<{ turnNode: string; chain: string[] }> = [];
    for (const turn of sessionTurns) {
      const nodeMap = byTurnNodeName.get(turn.nodeName);
      if (!nodeMap) continue;
      const chain = Array.from(nodeMap.entries())
        .map(([name, meta]) => ({ name, firstStartMs: meta.firstStartMs }))
        .sort((a, b) => a.firstStartMs - b.firstStartMs)
        .map((x) => x.name);

      // Ensure the turn node is first if present.
      if (chain.includes(turn.nodeName)) {
        const without = chain.filter((n) => n !== turn.nodeName);
        turnChains.push({
          turnNode: turn.nodeName,
          chain: [turn.nodeName, ...without],
        });
      } else {
        turnChains.push({ turnNode: turn.nodeName, chain });
      }
    }

    // Connect sequentially inside each turn.
    for (const { chain } of turnChains) {
      for (let i = 0; i < chain.length - 1; i++) {
        addEdge(chain[i]!, chain[i + 1]!);
      }
    }

    // Connect turns: last node of previous turn → next session.turn.xxx node.
    for (let i = 0; i < turnChains.length - 1; i++) {
      const prev = turnChains[i]!;
      const next = turnChains[i + 1]!;
      const prevLast = prev.chain[prev.chain.length - 1];
      if (prevLast) {
        addEdge(prevLast, next.turnNode);
      }
    }

    // Attach parser nodes:
    // - parser.<tool>.<n> (tool_result) → <tool>.<n>
    // - parser.turn_XXX.tool_call.<tool>.<n> → <tool>.<n>
    // - parser.turn_XXX.structured_output → latest kernel node for that turn
    const TOOL_CALL_UI_NODE_RE =
      /^parser\.turn_\d+\.tool_call\.(?<toolName>[^.]+)\.(?<index>\d+)$/;
    const SESSION_OUTPUT_NODE_RE = /^session\.output\.turn_(?<turn>\d+)$/;

    // Find which turn a node belongs to by time window (based on first occurrence).
    const nodeFirstStart = new Map<string, number>();
    obsChrono.forEach((o) => {
      const existing = nodeFirstStart.get(o.normalizedNodeName);
      if (existing === undefined || o.startMs < existing) {
        nodeFirstStart.set(o.normalizedNodeName, o.startMs);
      }
    });
    const findTurnForNode = (nodeName: string): string | null => {
      const ts = nodeFirstStart.get(nodeName);
      if (ts === undefined) return null;
      for (let i = 0; i < sessionTurns.length; i++) {
        const t = sessionTurns[i]!;
        const endBound = sessionTurnEndBounds[i] ?? Number.POSITIVE_INFINITY;
        if (ts >= t.start && ts < endBound) return t.nodeName;
      }
      return null;
    };

    for (const nodeName of normalizedNodeToObservationsMap.keys()) {
      if (!nodeName.startsWith("parser.")) continue;

      const toolResultMatch = TOOL_RESULT_UI_NODE_RE.exec(nodeName);
      if (toolResultMatch?.groups?.toolName && toolResultMatch.groups.index) {
        const parent = `${toolResultMatch.groups.toolName}.${toolResultMatch.groups.index}`;
        if (nodeExists(parent)) addEdge(parent, nodeName);
        continue;
      }

      const toolCallMatch = TOOL_CALL_UI_NODE_RE.exec(nodeName);
      if (toolCallMatch?.groups?.toolName && toolCallMatch.groups.index) {
        const parent = `${toolCallMatch.groups.toolName}.${toolCallMatch.groups.index}`;
        if (nodeExists(parent)) addEdge(parent, nodeName);
        continue;
      }

      if (STRUCTURED_OUTPUT_UI_NODE_RE.test(nodeName)) {
        const turnNode = findTurnForNode(nodeName);
        const kernelNode =
          (turnNode ? latestKernelByTurn.get(turnNode) : null) ?? null;
        if (kernelNode && nodeExists(kernelNode)) {
          addEdge(kernelNode, nodeName);
        }
        continue;
      }
    }

    // Connect __start__ to the first node of the first turn.
    const firstTurnMainNode = turnChains.find((t) => t.chain.length > 0)
      ?.chain[0];

    // Prefer a dedicated trace-start node if present; otherwise fall back to the first turn node.
    // This avoids `session.trace.start` becoming an isolated node in some traces.
    const TRACE_START_NODE_NAME = "session.trace.start";
    const traceStartNode = nodeExists(TRACE_START_NODE_NAME)
      ? TRACE_START_NODE_NAME
      : null;

    const startAnchor = traceStartNode ?? firstTurnMainNode ?? null;
    if (startAnchor) {
      addEdge(LANGFUSE_START_NODE_NAME, startAnchor);
    }

    if (
      traceStartNode &&
      firstTurnMainNode &&
      traceStartNode !== firstTurnMainNode
    ) {
      addEdge(traceStartNode, firstTurnMainNode);
    }

    // Only the global last main-chain node connects to __end__.
    const lastMainNode = [...turnChains]
      .reverse()
      .find((t) => t.chain.length > 0)
      ?.chain.slice(-1)[0];
    if (lastMainNode) {
      addEdge(lastMainNode, LANGFUSE_END_NODE_NAME);
    }

    // Cleanup: remove any edges into __end__ that are not from the last main node.
    if (lastMainNode) {
      for (const key of Array.from(edgesSet)) {
        const [from, to] = key.split("→");
        if (to === LANGFUSE_END_NODE_NAME && from !== lastMainNode) {
          edgesSet.delete(key);
        }
      }
    }
  } else {
    // Fallback: no turn structure available → keep step-based rendering, but still:
    // - prevent outgoing edges from parser nodes
    // - avoid a noisy fan-out into __end__ (only last-step nodes connect to __end__)
    const stepEdges = generateEdgesWithParallelBranches(
      normalizedStepToNodesMap,
    );
    stepEdges.forEach(({ from, to }) => addEdge(from, to));

    forcedParentByNodeName.forEach((parent, child) => addEdge(parent, child));
  }

  const edges = Array.from(edgesSet).map((key) => {
    const [from, to] = key.split("→");
    return { from: from!, to: to! };
  });

  return {
    graph: { nodes, edges },
    nodeToObservationsMap: Object.fromEntries(
      normalizedNodeToObservationsMap.entries(),
    ),
  };
}

function getRedundantParserNodes(stepToNodesMap: Map<number, Set<string>>) {
  const parserNodesByTurn = new Map<
    number,
    { nodeName: string; suffix: string; hasSuffix: boolean }[]
  >();

  stepToNodesMap.forEach((nodesAtStep) => {
    nodesAtStep.forEach((nodeName) => {
      const parsed = parseParserNodeName(nodeName);
      if (!parsed) {
        return;
      }

      const suffix = parsed.suffixSegments.join(".");
      if (!parserNodesByTurn.has(parsed.turn)) {
        parserNodesByTurn.set(parsed.turn, []);
      }

      parserNodesByTurn.get(parsed.turn)!.push({
        nodeName,
        suffix,
        hasSuffix: parsed.suffixSegments.length > 0,
      });
    });
  });

  const nodesToPrune = new Set<string>();

  parserNodesByTurn.forEach((turnNodes) => {
    turnNodes.forEach(({ nodeName, suffix, hasSuffix }) => {
      const isContainerNode =
        !hasSuffix ||
        suffix === "tool_calls" ||
        suffix === "tool_results" ||
        suffix === "tool_call" ||
        suffix === "tool_result";

      if (isContainerNode) {
        nodesToPrune.add(nodeName);
      }
    });
  });

  return nodesToPrune;
}

function generateEdgesWithParallelBranches(
  stepToNodesMap: Map<number, Set<string>>,
) {
  // generate edges with proper parallel branch handling
  const sortedSteps = [...stepToNodesMap.entries()].sort(([a], [b]) => a - b);
  const edges: Array<{ from: string; to: string }> = [];

  sortedSteps.forEach(([, currentNodes], i) => {
    const isLastStep = i === sortedSteps.length - 1;
    const targetNodes = isLastStep
      ? [LANGFUSE_END_NODE_NAME]
      : Array.from(sortedSteps[i + 1][1]);

    // connect all current nodes to all target nodes
    Array.from(currentNodes).forEach((currentNode) => {
      // end nodes should be terminal -> don't draw edges from them
      if (
        currentNode === LANGFUSE_END_NODE_NAME ||
        currentNode === LANGGRAPH_END_NODE_NAME
      ) {
        return;
      }

      targetNodes.forEach((targetNode) => {
        if (currentNode !== targetNode) {
          edges.push({ from: currentNode, to: targetNode });
        }
      });
    });
  });

  return edges;
}
