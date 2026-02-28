import React, {
  useEffect,
  useRef,
  useMemo,
  useState,
  useCallback,
} from "react";
import { Network, DataSet } from "vis-network/standalone";
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Maximize2,
  GitBranch,
  Search,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";

import type { GraphCanvasData, GraphNodeData, TraceGraphMode } from "../types";
import {
  LANGFUSE_START_NODE_NAME,
  LANGFUSE_END_NODE_NAME,
  LANGGRAPH_START_NODE_NAME,
  LANGGRAPH_END_NODE_NAME,
} from "../types";
import { Button } from "@/src/components/ui/button";
import { Dialog, DialogContent } from "@/src/components/ui/dialog";
import { Input } from "@/src/components/ui/input";
import { cn } from "@/src/utils/tailwind";

type TraceGraphCanvasProps = {
  graph: GraphCanvasData;
  graphMode: TraceGraphMode;
  selectedNodeName: string | null;
  onCanvasNodeNameChange: (
    nodeName: string | null,
    options?: { shouldCycleObservation?: boolean },
  ) => void;
  disablePhysics?: boolean;
  nodeToObservationsMap?: Record<string, string[]>;
  currentObservationIndices?: Record<string, number>;
  onGraphModeToggle?: () => void;
  allowFullscreen?: boolean;
  whiteBackground?: boolean;
};

export const TraceGraphCanvas: React.FC<TraceGraphCanvasProps> = (props) => {
  const {
    graph: graphData,
    graphMode,
    selectedNodeName,
    onCanvasNodeNameChange,
    disablePhysics = false,
    nodeToObservationsMap = {},
    currentObservationIndices = {},
    onGraphModeToggle,
    allowFullscreen = true,
    whiteBackground = false,
  } = props;
  const [isHovering, setIsHovering] = useState(false);
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const nodesDataSetRef = useRef<DataSet<any> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const onCanvasNodeNameChangeRef = useRef(onCanvasNodeNameChange);

  // Keep ref up to date without triggering Network recreation
  useEffect(() => {
    onCanvasNodeNameChangeRef.current = onCanvasNodeNameChange;
  }, [onCanvasNodeNameChange]);

  const getNodeStyle = (params: {
    nodeType: string;
    level?: string | null;
  }) => {
    if (params.level === "ERROR") {
      return {
        border: "#b91c1c", // red-700
        background: "#fee2e2", // red-100
        highlight: { border: "#991b1b", background: "#fecaca" }, // red-800 / red-200
      };
    }
    if (params.level === "WARNING") {
      return {
        border: "#b45309", // amber-700
        background: "#ffedd5", // orange-100
        highlight: { border: "#92400e", background: "#fed7aa" }, // amber-800 / orange-200
      };
    }

    switch (params.nodeType) {
      case "AGENT":
        return {
          border: "#c4b5fd", // purple-300 (former background)
          background: "#f3f4f6", // gray-100
          highlight: { border: "#a78bfa", background: "#e5e7eb" }, // gray-200
        };
      case "INTENT":
        return {
          border: "#99f6e4", // teal-200
          background: "#f3f4f6", // gray-100
          highlight: { border: "#2dd4bf", background: "#e5e7eb" }, // teal-400
        };
      case "POLICY":
        return {
          border: "#fca5a5", // red-300-ish
          background: "#f3f4f6", // gray-100
          highlight: { border: "#f87171", background: "#e5e7eb" }, // red-400-ish
        };
      case "TOOLS":
        return {
          border: "#fdba74", // orange-300
          background: "#f3f4f6", // gray-100
          highlight: { border: "#fb923c", background: "#e5e7eb" }, // orange-400
        };
      case "OUTPUT":
        return {
          border: "#a7f3d0", // emerald-200
          background: "#f3f4f6", // gray-100
          highlight: { border: "#34d399", background: "#e5e7eb" }, // emerald-400
        };
      case "TOOL":
        return {
          border: "#fed7aa", // orange-300 (former background)
          background: "#f3f4f6", // gray-100
          highlight: { border: "#fdba74", background: "#e5e7eb" }, // gray-200
        };
      case "GENERATION":
        return {
          border: "#f0abfc", // fuchsia-300 (former background)
          background: "#f3f4f6", // gray-100
          highlight: { border: "#e879f9", background: "#e5e7eb" }, // gray-200
        };
      case "SPAN":
        return {
          border: "#93c5fd", // blue-300 (former background)
          background: "#f3f4f6", // gray-100
          highlight: { border: "#60a5fa", background: "#e5e7eb" }, // gray-200
        };
      case "CHAIN":
        return {
          border: "#f9a8d4", // pink-300 (former background)
          background: "#f3f4f6", // gray-100
          highlight: { border: "#f472b6", background: "#e5e7eb" }, // gray-200
        };
      case "RETRIEVER":
        return {
          border: "#5eead4", // teal-300 (former background)
          background: "#f3f4f6", // gray-100
          highlight: { border: "#2dd4bf", background: "#e5e7eb" }, // gray-200
        };
      case "EVENT":
        return {
          border: "#6ee7b7", // green-300 (former background)
          background: "#f3f4f6", // gray-100
          highlight: { border: "#34d399", background: "#e5e7eb" }, // gray-200
        };
      case "PARSER":
        return {
          border: "#a5b4fc", // indigo-300
          background: "#f3f4f6", // gray-100
          highlight: { border: "#818cf8", background: "#e5e7eb" }, // indigo-400
        };
      case "EMBEDDING":
        return {
          border: "#fbbf24", // amber-300 (former background)
          background: "#f3f4f6", // gray-100
          highlight: { border: "#f59e0b", background: "#e5e7eb" }, // gray-200
        };
      case "GUARDRAIL":
        return {
          border: "#fca5a5", // red-300 (former background)
          background: "#f3f4f6", // gray-100
          highlight: { border: "#f87171", background: "#e5e7eb" }, // gray-200
        };
      case "LANGGRAPH_SYSTEM":
        return {
          border: "#d1d5db", // gray (former background)
          background: "#f3f4f6", // gray-100
          highlight: { border: "#9ca3af", background: "#e5e7eb" }, // gray-200
        };
      default:
        return {
          border: "#93c5fd", // blue-300 (former background)
          background: "#f3f4f6", // gray-100
          highlight: { border: "#60a5fa", background: "#e5e7eb" }, // gray-200
        };
    }
  };

  const nodes = useMemo(() => {
    const seen = new Set<string>();
    const uniqueNodes = graphData.nodes.filter((node) => {
      if (seen.has(node.id)) return false;
      seen.add(node.id);
      return true;
    });

    return uniqueNodes.map((node) => {
      const metadataLines =
        graphMode === "hierarchy" && node.metadataSummary
          ? [
              node.metadataSummary.core
                ? `Core: ${truncateText(node.metadataSummary.core, 24)}`
                : null,
              node.metadataSummary.category
                ? `Category: ${truncateText(node.metadataSummary.category, 24)}`
                : null,
              node.metadataSummary.instructionType
                ? `Type: ${truncateText(node.metadataSummary.instructionType, 24)}`
                : null,
              node.metadataSummary.policy?.authorityLabel
                ? `Policy: ${truncateText(
                    `${node.metadataSummary.policy.authorityLabel}${node.metadataSummary.policy.hasBlock ? " (BLOCK)" : ""}`,
                    32,
                  )}`
                : node.metadataSummary.policy?.hasBlock
                  ? "Policy: BLOCK"
                  : null,
              node.metadataSummary.observationCount != null
                ? `Obs: ${node.metadataSummary.observationCount} | Tools: ${node.metadataSummary.toolCount ?? 0}`
                : null,
              (node.metadataSummary.errorCount ?? 0) > 0 ||
              (node.metadataSummary.warningCount ?? 0) > 0 ||
              (node.metadataSummary.parserInconsistencyCount ?? 0) > 0
                ? `Risk: E${node.metadataSummary.errorCount ?? 0} W${node.metadataSummary.warningCount ?? 0} P${node.metadataSummary.parserInconsistencyCount ?? 0}`
                : null,
            ].filter((line): line is string => Boolean(line))
          : [];

      const label =
        metadataLines.length > 0
          ? `${node.label}\n${metadataLines.join("\n")}`
          : node.label;

      const hasShortLabel = node.label !== node.id;
      const nodeData = {
        id: node.id,
        label,
        color: getNodeStyle({ nodeType: node.type, level: node.level }),
        title: node.title ?? (hasShortLabel ? node.id : undefined),
      };

      // Special positioning and colors for system nodes
      if (
        node.id === LANGFUSE_START_NODE_NAME ||
        node.id === LANGGRAPH_START_NODE_NAME
      ) {
        return {
          ...nodeData,
          x: -200,
          y: 0,
          color: {
            border: "#166534", // green
            background: "#86efac",
            highlight: {
              border: "#15803d",
              background: "#4ade80",
            },
          },
        };
      }
      if (
        node.id === LANGFUSE_END_NODE_NAME ||
        node.id === LANGGRAPH_END_NODE_NAME
      ) {
        return {
          ...nodeData,
          x: 200,
          y: 0,
          color: {
            border: "#7f1d1d", // red
            background: "#fecaca",
            highlight: {
              border: "#991b1b",
              background: "#fca5a5",
            },
          },
        };
      }
      return nodeData;
    });
  }, [graphData.nodes, graphMode]);

  const options = useMemo(
    () => ({
      autoResize: true,
      layout: {
        hierarchical: {
          enabled: true,
          direction: "UD", // Up-Down (top to bottom)
          levelSeparation: 60,
          nodeSpacing: 175,
          sortMethod: "hubsize",
          shakeTowards: "roots",
        },
        randomSeed: 1,
      },
      physics: {
        enabled: !disablePhysics,
        stabilization: {
          iterations: disablePhysics ? 0 : 500,
        },
      },
      interaction: {
        // Enable mouse wheel and touchpad pinch zoom on graph canvas.
        zoomView: true,
        // Enable dragging on empty canvas to pan whole graph.
        dragView: true,
      },
      nodes: {
        shape: "box",
        margin: {
          top: graphMode === "hierarchy" ? 8 : 10,
          right: graphMode === "hierarchy" ? 8 : 10,
          bottom: graphMode === "hierarchy" ? 8 : 10,
          left: graphMode === "hierarchy" ? 8 : 10,
        },
        borderWidth: 2,
        font: {
          size: graphMode === "hierarchy" ? 13 : 14,
          color: "#000000",
        },
        shadow: {
          enabled: true,
          color: "rgba(0,0,0,0.2)",
          size: 3,
          x: 3,
          y: 3,
        },
        scaling: {
          label: {
            enabled: true,
            min: 14,
            max: 16,
          },
        },
      },
      edges: {
        arrows: {
          to: { enabled: true, scaleFactor: 0.5 },
        },
        width: 1.5,
        color: {
          color: "#64748b",
        },
        selectionWidth: 0,
        chosen: false,
      },
    }),
    [disablePhysics, graphMode],
  );

  const handleZoomIn = () => {
    if (networkRef.current) {
      const currentScale = networkRef.current.getScale();
      networkRef.current.moveTo({
        scale: currentScale * 1.2,
      });
    }
  };

  const handleZoomOut = () => {
    if (networkRef.current) {
      const currentScale = networkRef.current.getScale();
      networkRef.current.moveTo({
        scale: currentScale / 1.2,
      });
    }
  };

  const handleReset = () => {
    if (networkRef.current) {
      networkRef.current.fit({
        animation: {
          duration: 300,
          easingFunction: "easeInOutQuad",
        },
      });
    }
  };

  const searchResultNodeIds = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    return Array.from(
      new Set(
        graphData.nodes
          .filter((node) =>
            buildSearchableNodeText(node).includes(normalizedQuery),
          )
          .map((node) => node.id),
      ),
    );
  }, [graphData.nodes, searchQuery]);

  const focusNode = useCallback((nodeId: string) => {
    const network = networkRef.current;
    if (!network) return;
    try {
      network.focus(nodeId, {
        scale: Math.max(network.getScale(), 0.9),
        animation: {
          duration: 250,
          easingFunction: "easeInOutQuad",
        },
      });
    } catch (error) {
      console.error("Error focusing node:", nodeId, error);
    }
  }, []);

  useEffect(() => {
    if (!isSearchOpen) return;
    const frameId = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [isSearchOpen]);

  useEffect(() => {
    setActiveSearchResultIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (searchResultNodeIds.length === 0) return;
    if (activeSearchResultIndex <= searchResultNodeIds.length - 1) return;
    setActiveSearchResultIndex(searchResultNodeIds.length - 1);
  }, [searchResultNodeIds.length, activeSearchResultIndex]);

  useEffect(() => {
    const normalizedQuery = searchQuery.trim();
    if (!normalizedQuery || searchResultNodeIds.length === 0) {
      return;
    }

    const resultIndex = Math.min(
      activeSearchResultIndex,
      searchResultNodeIds.length - 1,
    );
    const matchedNodeId = searchResultNodeIds[resultIndex];
    if (!matchedNodeId) {
      return;
    }

    if (selectedNodeName !== matchedNodeId) {
      onCanvasNodeNameChangeRef.current(matchedNodeId, {
        shouldCycleObservation: false,
      });
    }
    focusNode(matchedNodeId);
  }, [
    activeSearchResultIndex,
    focusNode,
    searchQuery,
    searchResultNodeIds,
    selectedNodeName,
  ]);

  const moveSearchSelection = useCallback(
    (direction: 1 | -1) => {
      if (searchResultNodeIds.length === 0) return;
      setActiveSearchResultIndex((currentIndex) => {
        const nextIndex =
          (currentIndex + direction + searchResultNodeIds.length) %
          searchResultNodeIds.length;
        return nextIndex;
      });
    },
    [searchResultNodeIds.length],
  );

  const toggleSearch = useCallback(() => {
    setIsSearchOpen((previous) => {
      const next = !previous;
      if (!next) {
        setSearchQuery("");
        setActiveSearchResultIndex(0);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const nodesDataSet = new DataSet(nodes);
    nodesDataSetRef.current = nodesDataSet;

    // Create the network
    const network = new Network(
      containerRef.current,
      { ...graphData, nodes: nodesDataSet },
      options,
    );
    networkRef.current = network;
    network.fit({
      animation: false,
    });

    // Use click event instead of selectNode/deselectNode to handle cycling properly
    network.on("click", (params) => {
      if (params.nodes.length > 0) {
        // Node was clicked
        onCanvasNodeNameChangeRef.current(params.nodes[0], {
          shouldCycleObservation: true,
        });
      } else {
        // Empty area was clicked
        onCanvasNodeNameChangeRef.current(null);
        network.unselectAll();
      }
    });

    // Prevent dragging the view completely out of bounds
    // this resets the graph position so that always a little bit is visible
    const constrainView = () => {
      const position = network.getViewPosition();
      const scale = network.getScale();
      const container = containerRef.current;

      if (!container) return;
      const containerRect = container.getBoundingClientRect();

      const nodePositions = network.getPositions();
      const nodeIds = Object.keys(nodePositions);

      if (nodeIds.length === 0) {
        return;
      }

      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;

      nodeIds.forEach((nodeId) => {
        const pos = nodePositions[nodeId];
        minX = Math.min(minX, pos.x);
        maxX = Math.max(maxX, pos.x);
        minY = Math.min(minY, pos.y);
        maxY = Math.max(maxY, pos.y);
      });

      // Add some padding for node sizes (approximate node width/height)
      const nodePadding = 100;
      const graphWidth = (maxX - minX + nodePadding * 2) * scale;
      const graphHeight = (maxY - minY + nodePadding * 2) * scale;

      // max amount that a graph can be dragged on respective axis
      const maxDragX = (containerRect.width / 2 + graphWidth * 0.35) / scale;
      const maxDragY = (containerRect.height / 2 + graphHeight * 0.35) / scale;

      // Clamp position within bounds
      const constrainedX = Math.max(-maxDragX, Math.min(maxDragX, position.x));
      const constrainedY = Math.max(-maxDragY, Math.min(maxDragY, position.y));

      if (constrainedX !== position.x || constrainedY !== position.y) {
        network.moveTo({
          position: { x: constrainedX, y: constrainedY },
          scale: scale,
          animation: false,
        });
      }
    };

    // Apply constraints after drag ends
    network.on("dragEnd", (params) => {
      // only if dragging graph not nodes
      if (params.nodes.length === 0) {
        constrainView();
      }
    });

    network.on("zoom", () => {
      constrainView();
    });

    // force redraw on resetting view
    const handleResize = () => {
      if (network) {
        network.redraw();
        network.fit();
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      networkRef.current = null;
      nodesDataSetRef.current = null;
      network.destroy();
    };
  }, [graphData, nodes, options]);

  // Update node labels when observation indices change, without recreating network
  useEffect(() => {
    const nodesDataSet = nodesDataSetRef.current;
    if (!nodesDataSet) return;

    try {
      const updates: { id: string; label: string }[] = [];

      graphData.nodes.forEach((node) => {
        const isSystemNode =
          node.id === LANGFUSE_START_NODE_NAME ||
          node.id === LANGFUSE_END_NODE_NAME ||
          node.id === LANGGRAPH_START_NODE_NAME ||
          node.id === LANGGRAPH_END_NODE_NAME;

        if (isSystemNode) return;

        const observations = nodeToObservationsMap[node.id] || [];
        const currentIndex = currentObservationIndices[node.id] || 0;
        const counter =
          observations.length > 1
            ? ` (${observations.length - currentIndex}/${observations.length})`
            : "";

        const newLabel = `${node.label}${counter}`;
        updates.push({ id: node.id, label: newLabel });
      });

      if (updates.length > 0) {
        nodesDataSet.update(updates);
      }
    } catch (error) {
      console.error("Error updating node labels:", error);
    }
  }, [graphData.nodes, nodeToObservationsMap, currentObservationIndices]);

  useEffect(() => {
    const network = networkRef.current;
    if (!network) return;

    if (selectedNodeName) {
      // Validate that the node exists before trying to select it
      const nodeExists = graphData.nodes.some(
        (node) => node.id === selectedNodeName,
      );

      if (nodeExists) {
        try {
          network.selectNodes([selectedNodeName]);
        } catch (error) {
          console.error("Error selecting node:", selectedNodeName, error);
          // Fallback to clearing selection
          network.unselectAll();
        }
      } else {
        console.warn(
          "Cannot select node that doesn't exist:",
          selectedNodeName,
        );
        network.unselectAll();
      }
    } else {
      network.unselectAll();
    }
  }, [selectedNodeName, graphData.nodes]);

  if (!graphData.nodes.length) {
    return (
      <div className="flex h-full items-center justify-center">
        No graph data available
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          "relative h-full min-h-[50dvh] w-full pb-2",
          whiteBackground && "bg-white",
        )}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        {(isHovering || isSearchOpen) && (
          <div className="absolute right-2 top-2 z-10 flex items-start gap-2">
            {isSearchOpen && (
              <div className="flex min-w-64 items-center gap-1 rounded-md border bg-background/95 p-1 shadow-md dark:shadow-border">
                <Input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    moveSearchSelection(event.shiftKey ? -1 : 1);
                  }}
                  placeholder="Search node..."
                  className="h-8 border-0 bg-transparent shadow-none focus-visible:ring-0"
                />
                <span className="min-w-12 text-center text-xs text-muted-foreground">
                  {searchQuery.trim().length === 0
                    ? "Search"
                    : searchResultNodeIds.length === 0
                      ? "No match"
                      : `${activeSearchResultIndex + 1}/${searchResultNodeIds.length}`}
                </span>
                <Button
                  onClick={() => moveSearchSelection(-1)}
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 p-1"
                  title="Previous match"
                  disabled={searchResultNodeIds.length < 2}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  onClick={() => moveSearchSelection(1)}
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 p-1"
                  title="Next match"
                  disabled={searchResultNodeIds.length < 2}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <Button
                  onClick={toggleSearch}
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 p-1"
                  title="Close search"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Button
                onClick={toggleSearch}
                variant="ghost"
                size="icon"
                className="p-1.5 shadow-md dark:shadow-border"
                title="Search nodes"
              >
                <Search className="h-4 w-4" />
              </Button>
              <Button
                onClick={handleZoomIn}
                variant="ghost"
                size="icon"
                className="p-1.5 shadow-md dark:shadow-border"
                title="Zoom in"
              >
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button
                onClick={handleZoomOut}
                variant="ghost"
                size="icon"
                className="p-1.5 shadow-md dark:shadow-border"
                title="Zoom out"
              >
                <ZoomOut className="h-4 w-4" />
              </Button>
              <Button
                onClick={handleReset}
                variant="ghost"
                size="icon"
                className="p-1.5 shadow-md dark:shadow-border"
                title="Reset view"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
              {allowFullscreen && (
                <Button
                  onClick={() => setIsFullscreenOpen(true)}
                  variant="ghost"
                  size="icon"
                  className="p-1.5 shadow-md dark:shadow-border"
                  title="Open fullscreen graph"
                >
                  <Maximize2 className="h-4 w-4" />
                </Button>
              )}
              {onGraphModeToggle && (
                <Button
                  onClick={onGraphModeToggle}
                  variant="ghost"
                  size="icon"
                  className="p-1.5 shadow-md dark:shadow-border"
                  title={
                    graphMode === "hierarchy"
                      ? "Switch to execution flow graph"
                      : "Switch to hierarchy graph"
                  }
                >
                  <GitBranch className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        )}
        <div ref={containerRef} className="h-full w-full" />
      </div>
      {allowFullscreen && (
        <Dialog open={isFullscreenOpen} onOpenChange={setIsFullscreenOpen}>
          <DialogContent size="xxl" className="overflow-hidden bg-white p-0">
            <div className="h-full w-full bg-white p-3">
              <TraceGraphCanvas
                graph={graphData}
                graphMode={graphMode}
                selectedNodeName={selectedNodeName}
                onCanvasNodeNameChange={onCanvasNodeNameChange}
                disablePhysics={disablePhysics}
                nodeToObservationsMap={nodeToObservationsMap}
                currentObservationIndices={currentObservationIndices}
                onGraphModeToggle={onGraphModeToggle}
                allowFullscreen={false}
                whiteBackground={true}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}...`;
}

function buildSearchableNodeText(node: GraphNodeData): string {
  return [node.id, node.label, node.type, node.title ?? "", node.level ?? ""]
    .join(" ")
    .toLowerCase();
}
