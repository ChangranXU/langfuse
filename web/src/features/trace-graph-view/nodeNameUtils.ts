const LEGACY_TOOL_RESULT_NODE_RE =
  /^tool\.(?<toolName>.+)\.result\.call_(?<index>\d+)$/;

export function normalizeToolResultNodeName(
  nodeName: string | null | undefined,
): string | null | undefined {
  if (!nodeName) {
    return nodeName;
  }

  const match = LEGACY_TOOL_RESULT_NODE_RE.exec(nodeName);
  if (!match?.groups) {
    return nodeName;
  }

  const toolName = match.groups.toolName?.trim();
  const index = match.groups.index;
  if (!toolName || !index) {
    return nodeName;
  }

  return `${toolName}.${index}`;
}
