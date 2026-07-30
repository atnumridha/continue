export interface ContextUsageSnapshot {
  inputTokens: number;
  contextLength: number;
  availableTokens?: number;
  model?: string;
  tokenBreakdown?: {
    system: number;
    history: number;
    latest: number;
    tools: number;
    safetyBuffer: number;
    reservedOutput: number;
  };
}

export function reconcileContextUsageSnapshot(
  usage: ContextUsageSnapshot | undefined,
  configuredContextLength: number,
  selectedModel?: string,
): { usage: ContextUsageSnapshot | undefined; isStale: boolean } {
  const isStale = Boolean(
    usage?.model && selectedModel && usage.model !== selectedModel,
  );
  if (!usage || isStale) return { usage: undefined, isStale };

  // A session can retain usage measured before model metadata refreshes. When
  // the selected model is unchanged, keep the measured input tokens but use
  // the current effective limit, just as Codex does with its model cache.
  if (
    selectedModel &&
    configuredContextLength > 0 &&
    usage.contextLength !== configuredContextLength
  ) {
    return {
      usage: {
        ...usage,
        contextLength: configuredContextLength,
        availableTokens: Math.max(
          0,
          configuredContextLength - usage.inputTokens,
        ),
      },
      isStale: false,
    };
  }

  return { usage, isStale: false };
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 || Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return tokens.toLocaleString();
}

export function contextUsagePresentation(
  usage: ContextUsageSnapshot | undefined,
  configuredContextLength: number,
) {
  const contextLength = usage?.contextLength ?? configuredContextLength;
  if (!usage) {
    return {
      short: `${formatTokenCount(contextLength)} window`,
      accessible: `Context window: ${contextLength.toLocaleString()} tokens. Usage will be calculated after the next message.`,
      percent: undefined,
    };
  }
  const percent = Math.min(
    100,
    Math.max(0, Math.round((usage.inputTokens / contextLength) * 100)),
  );
  return {
    short: `${formatTokenCount(usage.inputTokens)} / ${formatTokenCount(contextLength)}`,
    accessible: `Context window: ${usage.inputTokens.toLocaleString()} of ${contextLength.toLocaleString()} tokens used (${percent}%).`,
    percent,
  };
}
