import type { ChatHistoryItem } from "core";
import { chatMessageIsEmpty } from "core/llm/messages";

export const GUI_AUTO_COMPACTION_THRESHOLD = 0.55;
export const GUI_AUTO_COMPACTION_INPUT_TOKEN_THRESHOLD = 96_000;

function shouldAutoCompact(
  contextPercentage?: number,
  isPruned = false,
  inputTokens?: number,
): boolean {
  if (isPruned) {
    return true;
  }

  if (
    inputTokens !== undefined &&
    inputTokens >= GUI_AUTO_COMPACTION_INPUT_TOKEN_THRESHOLD
  ) {
    return true;
  }

  return (
    contextPercentage !== undefined &&
    contextPercentage >= GUI_AUTO_COMPACTION_THRESHOLD
  );
}

/** Find a stable completed response that is safe to use as a summary boundary. */
export function getManualCompactionTarget(
  history: ChatHistoryItem[],
  requestedIndex = history.length - 1,
): number | undefined {
  for (
    let index = Math.min(requestedIndex, history.length - 1);
    index >= 0;
    index--
  ) {
    const message = history[index].message;
    if (
      message.role === "assistant" &&
      !message.toolCalls?.length &&
      !chatMessageIsEmpty(message)
    ) {
      return index;
    }
  }
  return undefined;
}

/** Keep the active user turn intact and summarize only completed turns. */
export function getAutoCompactionTarget(
  history: ChatHistoryItem[],
  contextPercentage?: number,
  isPruned = false,
  inputTokens?: number,
): number | undefined {
  if (!shouldAutoCompact(contextPercentage, isPruned, inputTokens)) {
    return undefined;
  }

  let latestSummary = -1;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].conversationSummary !== undefined) {
      latestSummary = index;
      break;
    }
  }

  // Preserve the latest user turn and anything that follows it. Different
  // surfaces shape the active tail differently: GUI chat preallocates an empty
  // assistant item, tool follow-ups append tool messages, and retry/resume paths
  // may not have the same two-item tail. The invariant we actually need is:
  // compact only completed assistant turns before the latest active prompt.
  let protectedTailStart = history.length;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].message.role === "user") {
      protectedTailStart = index;
      break;
    }
  }

  // Walk backward to the newest completed non-tool assistant turn before the
  // protected tail. Assistant messages that still contain tool calls are not a
  // safe summary boundary because their paired tool output can follow later.
  for (let index = protectedTailStart - 1; index > latestSummary; index--) {
    const message = history[index].message;
    if (
      message.role === "assistant" &&
      !message.toolCalls?.length &&
      !chatMessageIsEmpty(message)
    ) {
      return index;
    }
  }
  return undefined;
}
