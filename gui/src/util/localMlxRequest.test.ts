import { describe, expect, it } from "vitest";
import type { RuleWithSource, Tool } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  compactRulesForLocalMlxRequest,
  isLocalMlxSupportPrompt,
  selectLocalMlxPromptRelevantTools,
} from "./localMlxRequest";

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
  tool(BuiltInToolNames.RunTerminalCommand),
  tool(BuiltInToolNames.ReadSkill),
  tool(BuiltInToolNames.ComputerUse),
  tool(BuiltInToolNames.EditExistingFile),
];

function names(tools: Tool[]) {
  return tools.map((tool) => tool.function.name);
}

function rule(overrides: Partial<RuleWithSource>): RuleWithSource {
  return {
    source: "rules-block",
    rule: "short rule",
    ...overrides,
  };
}

describe("localMlxRequest", () => {
  it("detects MOSFS and SR prompts as local support prompts", () => {
    expect(isLocalMlxSupportPrompt("review SR 4-0003325044 $mosfs")).toBe(true);
    expect(isLocalMlxSupportPrompt("review 4-0003325044")).toBe(true);
    expect(isLocalMlxSupportPrompt("review the current repo")).toBe(false);
  });

  it("keeps only the terminal command tool for local MLX MOSFS SR prompts", () => {
    expect(
      names(
        selectLocalMlxPromptRelevantTools(
          availableTools,
          "review SR 4-0003325044 $mosfs",
        ),
      ),
    ).toEqual([BuiltInToolNames.RunTerminalCommand]);
  });

  it("drops all tools for simple local MLX greetings", () => {
    expect(selectLocalMlxPromptRelevantTools(availableTools, "Hello")).toEqual(
      [],
    );
  });

  it("uses a small discovery set for local MLX repo review prompts", () => {
    expect(
      names(
        selectLocalMlxPromptRelevantTools(
          availableTools,
          "review the current repo",
        ),
      ),
    ).toEqual([
      BuiltInToolNames.ReadFile,
      BuiltInToolNames.FileGlobSearch,
      BuiltInToolNames.GrepSearch,
      BuiltInToolNames.ViewDiff,
    ]);
  });

  it("removes rules entirely for simple local MLX greetings", () => {
    const rules = [
      rule({
        name: "AGENTS",
        source: "agentFile",
        rule: "large agent rule".repeat(1000),
      }),
    ];

    expect(compactRulesForLocalMlxRequest(rules, "Hello")).toEqual([]);
  });

  it("compacts large MOSFS and agent rules for local MLX support prompts", () => {
    const rules = [
      rule({
        name: "mosfs",
        sourceFile: "file:///Users/amridha/.codex/skills/mosfs/SKILL.md",
        rule: "large mosfs rule".repeat(2000),
      }),
      rule({
        name: "AGENTS",
        source: "agentFile",
        sourceFile: "file:///workspace/AGENTS.md",
        rule: "large agent rule".repeat(1000),
      }),
    ];

    const compacted = compactRulesForLocalMlxRequest(
      rules,
      "review SR 4-0003325044 $mosfs",
    );

    expect(compacted[0].rule).toContain("fetch_sr.py <SR_NUMBER>");
    expect(compacted[0].rule.length).toBeLessThan(900);
    expect(compacted[1].rule).toContain("Ground factual claims");
    expect(compacted[1].rule.length).toBeLessThan(700);
  });
});
