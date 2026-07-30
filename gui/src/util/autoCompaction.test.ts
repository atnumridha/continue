import type { ChatHistoryItem } from "core";
import { describe, expect, it } from "vitest";
import {
  getAutoCompactionTarget,
  getManualCompactionTarget,
} from "./autoCompaction";

const item = (
  role: "user" | "assistant",
  content: string,
): ChatHistoryItem => ({
  message: { role, content },
  contextItems: [],
});

describe("getAutoCompactionTarget", () => {
  it("compacts completed turns while preserving the active prompt", () => {
    const history = [
      item("user", "first"),
      item("assistant", "answer"),
      item("user", "current"),
      item("assistant", ""),
    ];
    expect(getAutoCompactionTarget(history, 0.8)).toBe(1);
  });

  it("works when the active prompt has no preallocated assistant response", () => {
    const history = [
      item("user", "first"),
      item("assistant", "answer"),
      item("user", "current"),
    ];
    expect(getAutoCompactionTarget(history, 0.8)).toBe(1);
  });

  it("preserves active tool loops while compacting earlier completed turns", () => {
    const history: ChatHistoryItem[] = [
      item("user", "first"),
      item("assistant", "answer"),
      item("user", "current"),
      {
        ...item("assistant", "running a tool"),
        message: {
          role: "assistant",
          content: "running a tool",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
      },
      {
        message: { role: "tool", content: "result", toolCallId: "call-1" },
        contextItems: [],
      },
    ];

    expect(getAutoCompactionTarget(history, 0.8)).toBe(1);
  });

  it("does not use an assistant tool-call message as a summary boundary", () => {
    const history: ChatHistoryItem[] = [
      item("user", "first"),
      {
        ...item("assistant", "running a tool"),
        message: {
          role: "assistant",
          content: "running a tool",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
      },
      {
        message: { role: "tool", content: "result", toolCallId: "call-1" },
        contextItems: [],
      },
      item("user", "current"),
      item("assistant", ""),
    ];

    expect(getAutoCompactionTarget(history, 0.95)).toBeUndefined();
  });

  it("does not repeatedly compact the same history", () => {
    const history = [
      item("user", "first"),
      { ...item("assistant", "answer"), conversationSummary: "summary" },
      item("user", "current"),
      item("assistant", ""),
    ];
    expect(getAutoCompactionTarget(history, 0.95)).toBeUndefined();
  });

  it("waits until the context threshold", () => {
    expect(
      getAutoCompactionTarget(
        [item("user", "first"), item("assistant", "answer")],
        0.54,
      ),
    ).toBeUndefined();
  });

  it("does not compact early on large-context models", () => {
    expect(
      getAutoCompactionTarget(
        [
          item("user", "first"),
          item("assistant", "answer"),
          item("user", "current"),
          item("assistant", ""),
        ],
        0.25,
        false,
        51_000,
      ),
    ).toBeUndefined();
  });

  it("compacts when absolute prompt tokens are high on large-context models", () => {
    expect(
      getAutoCompactionTarget(
        [
          item("user", "first"),
          item("assistant", "answer"),
          item("user", "current"),
          item("assistant", ""),
        ],
        0.1,
        false,
        96_000,
      ),
    ).toBe(1);
  });

  it("uses only completed non-tool responses as manual summary boundaries", () => {
    const history: ChatHistoryItem[] = [
      item("user", "first"),
      item("assistant", "complete answer"),
      item("user", "next"),
      {
        ...item("assistant", "running a tool"),
        message: {
          role: "assistant",
          content: "running a tool",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
      },
      {
        message: { role: "tool", content: "result", toolCallId: "call-1" },
        contextItems: [],
      },
    ];

    expect(getManualCompactionTarget(history)).toBe(1);
  });
});
