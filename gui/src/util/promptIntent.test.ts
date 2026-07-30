import { describe, expect, it } from "vitest";
import type { Tool } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  isSimpleConversationalPrompt,
  selectPromptRelevantTools,
} from "./promptIntent";

function tool(name: BuiltInToolNames): Tool {
  return {
    type: "function",
    displayTitle: name,
    wouldLikeTo: name,
    isCurrently: name,
    hasAlready: name,
    group: "Built-In",
    readonly: true,
    function: {
      name,
      description: `${name} description`,
      parameters: { type: "object", properties: {} },
    },
  };
}

const availableTools = [
  tool(BuiltInToolNames.ReadFile),
  tool(BuiltInToolNames.ReadFileRange),
  tool(BuiltInToolNames.FileGlobSearch),
  tool(BuiltInToolNames.GrepSearch),
  tool(BuiltInToolNames.ViewDiff),
  tool(BuiltInToolNames.ReadLints),
  tool(BuiltInToolNames.LSTool),
  tool(BuiltInToolNames.RunTerminalCommand),
  tool(BuiltInToolNames.ComputerUse),
  tool(BuiltInToolNames.EditExistingFile),
  tool(BuiltInToolNames.SearchWeb),
  tool(BuiltInToolNames.FetchUrlContent),
  tool(BuiltInToolNames.ReadSkill),
  tool(BuiltInToolNames.UpdatePlan),
];

function names(tools: Tool[]) {
  return tools.map((tool) => tool.function.name);
}

describe("promptIntent", () => {
  it("treats plain greetings as lightweight chat", () => {
    expect(isSimpleConversationalPrompt("Hello")).toBe(true);
    expect(isSimpleConversationalPrompt("thanks")).toBe(true);
    expect(isSimpleConversationalPrompt("Who are you?")).toBe(true);
  });

  it("keeps coding and workspace prompts agentic", () => {
    expect(isSimpleConversationalPrompt("Hello, review this code")).toBe(false);
    expect(isSimpleConversationalPrompt("Review the codebase")).toBe(false);
    expect(
      isSimpleConversationalPrompt("find root cause in the workspace"),
    ).toBe(false);
    expect(isSimpleConversationalPrompt("run tests")).toBe(false);
  });

  it("does not send tool schemas for simple greetings", () => {
    expect(selectPromptRelevantTools(availableTools, "Hello")).toEqual([]);
  });

  it("uses a lean discovery set for broad codebase review prompts", () => {
    expect(
      names(selectPromptRelevantTools(availableTools, "review the codebase")),
    ).toEqual([
      BuiltInToolNames.ReadFile,
      BuiltInToolNames.ReadFileRange,
      BuiltInToolNames.FileGlobSearch,
      BuiltInToolNames.GrepSearch,
      BuiltInToolNames.ViewDiff,
      BuiltInToolNames.ReadLints,
    ]);
  });

  it("adds mutating and terminal tools only when the prompt asks for them", () => {
    const selected = names(
      selectPromptRelevantTools(
        availableTools,
        "fix the failing tests and run the build",
      ),
    );

    expect(selected).toContain(BuiltInToolNames.EditExistingFile);
    expect(selected).toContain(BuiltInToolNames.RunTerminalCommand);
    expect(selected).not.toContain(BuiltInToolNames.ComputerUse);
    expect(selected).not.toContain(BuiltInToolNames.SearchWeb);
    expect(selected).not.toContain(BuiltInToolNames.ReadSkill);
  });

  it("keeps skill and terminal tools for explicit dollar skill invocations", () => {
    const selected = names(
      selectPromptRelevantTools(
        availableTools,
        "use $mosfs review 4-0003351421 and find the RCA",
      ),
    );

    expect(selected).toContain(BuiltInToolNames.ReadSkill);
    expect(selected).toContain(BuiltInToolNames.RunTerminalCommand);
    expect(selected).toContain(BuiltInToolNames.ReadFile);
    expect(selected).toContain(BuiltInToolNames.GrepSearch);
    expect(selected).not.toContain(BuiltInToolNames.ComputerUse);
    expect(selected).not.toContain(BuiltInToolNames.SearchWeb);
    expect(selected).not.toContain(BuiltInToolNames.EditExistingFile);
  });

  it("keeps skill and terminal tools for SR attachment follow-ups", () => {
    const selected = names(
      selectPromptRelevantTools(
        availableTools,
        "read the attachments provided by customer",
      ),
    );

    expect(selected).toContain(BuiltInToolNames.ReadSkill);
    expect(selected).toContain(BuiltInToolNames.RunTerminalCommand);
    expect(selected).toContain(BuiltInToolNames.ReadFile);
    expect(selected).toContain(BuiltInToolNames.GrepSearch);
    expect(selected).not.toContain(BuiltInToolNames.ComputerUse);
    expect(selected).not.toContain(BuiltInToolNames.EditExistingFile);
  });

  it("keeps web and browser tools scoped to web or UI prompts", () => {
    const selected = names(
      selectPromptRelevantTools(
        availableTools,
        "open https://example.com in the browser and inspect the page",
      ),
    );

    expect(selected).toContain(BuiltInToolNames.FetchUrlContent);
    expect(selected).toContain(BuiltInToolNames.SearchWeb);
    expect(selected).toContain(BuiltInToolNames.ComputerUse);
    expect(selected).not.toContain(BuiltInToolNames.EditExistingFile);
  });
});
