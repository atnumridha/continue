import type { ContextItem, PromptLog } from "core";

const MAX_PROMPT_LOG_TEXT_CHARS = 12_000;
const MAX_TOOL_ITEM_CONTENT_CHARS = 12_000;
const MAX_TOOL_OUTPUT_TOTAL_CHARS = 24_000;
const MAX_TOOL_PROMPT_ITEM_CONTENT_CHARS = 2_000;
const MAX_TOOL_PROMPT_OUTPUT_TOTAL_CHARS = 6_000;

function limitTextForHistory(
  value: string,
  maxChars: number,
  label: string,
  target = "session history",
): string {
  if (value.length <= maxChars) {
    return value;
  }

  const marker = `\n\n[${label} truncated for ${target}: ${value.length - maxChars} characters omitted]\n\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(remaining * 0.65);
  const tailLength = Math.max(0, remaining - headLength);

  return `${value.slice(0, headLength)}${marker}${tailLength > 0 ? value.slice(-tailLength) : ""}`;
}

export function limitPromptLogsForHistory(logs: PromptLog[]): PromptLog[] {
  return logs.map((log) => ({
    ...log,
    prompt: limitTextForHistory(
      log.prompt,
      MAX_PROMPT_LOG_TEXT_CHARS,
      "prompt log",
    ),
    completion: limitTextForHistory(
      log.completion,
      MAX_PROMPT_LOG_TEXT_CHARS,
      "completion log",
    ),
  }));
}

export function limitToolContextItemsForHistory(
  contextItems: ContextItem[],
): ContextItem[] {
  return limitToolContextItems(
    contextItems,
    MAX_TOOL_ITEM_CONTENT_CHARS,
    MAX_TOOL_OUTPUT_TOTAL_CHARS,
    "session history",
  );
}

export function limitToolContextItemsForPrompt(
  contextItems: ContextItem[],
): ContextItem[] {
  return limitToolContextItems(
    contextItems,
    MAX_TOOL_PROMPT_ITEM_CONTENT_CHARS,
    MAX_TOOL_PROMPT_OUTPUT_TOTAL_CHARS,
    "model prompt",
  );
}

function limitToolContextItems(
  contextItems: ContextItem[],
  maxItemChars: number,
  maxTotalChars: number,
  target: "session history" | "model prompt",
): ContextItem[] {
  let remainingTotal = maxTotalChars;

  return contextItems.map((item) => {
    if (typeof item.content !== "string" || item.content.length === 0) {
      return item;
    }

    const itemLimit = Math.max(0, Math.min(maxItemChars, remainingTotal));
    remainingTotal -= Math.min(item.content.length, itemLimit);

    if (item.content.length <= itemLimit) {
      return item;
    }

    return {
      ...item,
      description: item.description
        ? `${item.description} · truncated for ${target}`
        : `Truncated for ${target}`,
      content:
        itemLimit > 0
          ? limitTextForHistory(item.content, itemLimit, "tool output", target)
          : `[Tool output truncated for ${target}: ${item.content.length} characters omitted]`,
    };
  });
}
