import { JSONContent } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import { getEmptyRootState } from "../../../../util/test/mockStore";
import { resolveEditorContent } from "./resolveEditorContent";

function editorStateWithText(text: string): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

describe("resolveEditorContent", () => {
  it("does not attach the active file for a simple greeting", async () => {
    const ideMessenger = new MockIdeMessenger();
    const requestSpy = vi.spyOn(ideMessenger, "request");

    const result = await resolveEditorContent({
      editorState: editorStateWithText("Hello"),
      modifiers: { useCodebase: false, noContext: false },
      ideMessenger,
      defaultContextProviders: [],
      availableSlashCommands: [],
      dispatch: vi.fn(),
      getState: getEmptyRootState,
    });

    expect(result.selectedContextItems).toEqual([]);
    expect(requestSpy).not.toHaveBeenCalledWith(
      "context/getContextItems",
      expect.objectContaining({ name: "currentFile" }),
    );
  });

  it("keeps the active file for coding prompts", async () => {
    const ideMessenger = new MockIdeMessenger();
    const requestSpy = vi.spyOn(ideMessenger, "request");

    const result = await resolveEditorContent({
      editorState: editorStateWithText("review this code"),
      modifiers: { useCodebase: false, noContext: false },
      ideMessenger,
      defaultContextProviders: [],
      availableSlashCommands: [],
      dispatch: vi.fn(),
      getState: getEmptyRootState,
    });

    expect(result.selectedContextItems).toHaveLength(1);
    expect(requestSpy).toHaveBeenCalledWith("context/getContextItems", {
      name: "currentFile",
      query: "non-mention-usage",
      fullInput: "",
      selectedCode: [],
      isInAgentMode: true,
    });
  });
});
