import { markdownToRule } from "@qivryn/config-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDE } from "../..";
import { walkDirs } from "../../indexing/walkDir";
import {
  isCodebaseRulesFile,
  isRootOrDotQivrynRuleFile,
  isQivrynInternalAgentWorktreePath,
  loadCodebaseRules,
} from "./loadCodebaseRules";

// Mock dependencies
vi.mock("../../indexing/walkDir", () => ({
  walkDir: vi.fn(),
  walkDirs: vi.fn(),
}));

vi.mock("@qivryn/config-yaml", () => ({
  markdownToRule: vi.fn(),
}));

describe("loadCodebaseRules", () => {
  it("recognizes only colocated rules.md files", () => {
    expect(isCodebaseRulesFile("file:///repo/src/rules.md")).toBe(true);
    expect(isCodebaseRulesFile("file:///repo/.qivryn/rules.md")).toBe(true);
    expect(isCodebaseRulesFile("file:///repo/AGENTS.md")).toBe(false);
    expect(isCodebaseRulesFile("file:///repo/docs/AGENTS.md")).toBe(false);
    expect(isCodebaseRulesFile("file:///repo/.cursor/rules/react.mdc")).toBe(
      false,
    );
    expect(isCodebaseRulesFile("file:///repo/README.md")).toBe(false);
  });

  it("allows rule files only at workspace root or under .qivryn", () => {
    const workspaceDirs = ["file:///repo"];

    expect(
      isRootOrDotQivrynRuleFile("file:///repo/rules.md", workspaceDirs),
    ).toBe(true);
    expect(
      isRootOrDotQivrynRuleFile("file:///repo/.qivryn/rules.md", workspaceDirs),
    ).toBe(true);
    expect(
      isRootOrDotQivrynRuleFile(
        "file:///repo/.qivryn/rules/security/rules.md",
        workspaceDirs,
      ),
    ).toBe(true);
    expect(
      isRootOrDotQivrynRuleFile("file:///repo/src/rules.md", workspaceDirs),
    ).toBe(false);
    expect(
      isRootOrDotQivrynRuleFile("file:///repo/docs/rules.md", workspaceDirs),
    ).toBe(false);
    expect(
      isRootOrDotQivrynRuleFile("file:///other/rules.md", workspaceDirs),
    ).toBe(false);
  });

  it("excludes copied rules in Qivryn internal agent worktrees", () => {
    expect(
      isQivrynInternalAgentWorktreePath(
        "file:///Users/example/.qivryn/agents/worktrees/a1/extensions/cli/AGENTS.md",
      ),
    ).toBe(true);
    expect(
      isQivrynInternalAgentWorktreePath(
        "file:///workspace/extensions/cli/AGENTS.md",
      ),
    ).toBe(false);
  });
  // Mock IDE with properly typed mock functions
  const mockIde = {
    fileExists: vi.fn().mockImplementation(() => true),
    readFile: vi.fn() as unknown as IDE["readFile"] & {
      mockImplementation: Function;
    },
    getWorkspaceDirs: vi.fn() as unknown as IDE["getWorkspaceDirs"] & {
      mockImplementation: Function;
    },
  } as unknown as IDE;

  // Mock rule content
  const mockRuleContent: Record<string, string> = {
    "file:///workspace/rules.md": "# Root Rules\nFollow root standards",
    "file:///workspace/src/rules.md":
      "# General Rules\nFollow coding standards",
    "file:///workspace/src/redux/rules.md":
      '---\nglobs: "**/*.{ts,tsx}"\n---\n# Redux Rules\nUse Redux Toolkit',
    "file:///workspace/src/components/rules.md":
      '---\nglobs: ["**/*.tsx", "**/*.jsx"]\n---\n# Component Rules\nUse functional components',
    "file:///workspace/.qivryn/rules.md":
      "# Global Rules\nFollow project guidelines",
  };

  // Mock converted rules
  const mockConvertedRules: Record<string, any> = {
    "file:///workspace/rules.md": {
      name: "Root Rules",
      rule: "Follow root standards",
      source: "colocated-markdown",
      sourceFile: "file:///workspace/rules.md",
    },
    "file:///workspace/src/rules.md": {
      name: "General Rules",
      rule: "Follow coding standards",
      source: "colocated-markdown",
      sourceFile: "file:///workspace/src/rules.md",
    },
    "file:///workspace/src/redux/rules.md": {
      name: "Redux Rules",
      rule: "Use Redux Toolkit",
      globs: "**/*.{ts,tsx}",
      source: "colocated-markdown",
      sourceFile: "file:///workspace/src/redux/rules.md",
    },
    "file:///workspace/src/components/rules.md": {
      name: "Component Rules",
      rule: "Use functional components",
      globs: ["**/*.tsx", "**/*.jsx"],
      source: "colocated-markdown",
      sourceFile: "file:///workspace/src/components/rules.md",
    },
    "file:///workspace/.qivryn/rules.md": {
      name: "Global Rules",
      rule: "Follow project guidelines",
      source: "colocated-markdown",
      sourceFile: "file:///workspace/.qivryn/rules.md",
    },
  };

  beforeEach(() => {
    // Setup mocks
    vi.resetAllMocks();

    // Mock walkDirs to return our test files
    (walkDirs as any).mockResolvedValue([
      ...Object.keys(mockRuleContent),
      "file:///workspace/src/utils/helper.ts", // Non-rules file
    ]);

    // Mock getWorkspaceDirs to return a workspace directory
    (mockIde.getWorkspaceDirs as any).mockResolvedValue(["file:///workspace"]);

    // Mock readFile to return content based on path
    (mockIde.readFile as any).mockImplementation((path: string) => {
      return Promise.resolve(mockRuleContent[path] || "");
    });

    // Mock markdownToRule to return converted rules
    (markdownToRule as any).mockImplementation(
      (content: string, options: any) => {
        return mockConvertedRules[options.fileUri];
      },
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });
  it("should load only root and .qivryn rules.md files", async () => {
    const { rules, errors } = await loadCodebaseRules(mockIde);

    expect(walkDirs).toHaveBeenCalledWith(mockIde);

    expect(mockIde.readFile).toHaveBeenCalledTimes(2);
    expect(mockIde.readFile).toHaveBeenCalledWith("file:///workspace/rules.md");
    expect(mockIde.readFile).toHaveBeenCalledWith(
      "file:///workspace/.qivryn/rules.md",
    );
    expect(mockIde.readFile).not.toHaveBeenCalledWith(
      "file:///workspace/src/rules.md",
    );
    expect(mockIde.readFile).not.toHaveBeenCalledWith(
      "file:///workspace/src/redux/rules.md",
    );
    expect(mockIde.readFile).not.toHaveBeenCalledWith(
      "file:///workspace/src/components/rules.md",
    );

    expect(markdownToRule).toHaveBeenCalledTimes(2);

    expect(rules).toContainEqual(
      mockConvertedRules["file:///workspace/rules.md"],
    );
    expect(rules).toContainEqual(
      mockConvertedRules["file:///workspace/.qivryn/rules.md"],
    );

    // Should not have errors
    expect(errors).toHaveLength(0);
  });

  it("should handle errors when reading a rule file", async () => {
    // Setup mock to throw for a specific file
    (mockIde.readFile as any).mockImplementation((path: string) => {
      if (path === "file:///workspace/.qivryn/rules.md") {
        return Promise.reject(new Error("Failed to read file"));
      }
      return Promise.resolve(mockRuleContent[path] || "");
    });

    const { rules, errors } = await loadCodebaseRules(mockIde);

    // Should still return other rules
    expect(rules).toHaveLength(1);
    expect(rules).toContainEqual(
      mockConvertedRules["file:///workspace/rules.md"],
    );

    // Should have one error
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(
      "Failed to parse colocated rule file file:///workspace/.qivryn/rules.md: Failed to read file",
    );
  });

  it("does not load rules copied into Qivryn internal agent worktrees", async () => {
    const copiedRule =
      "file:///Users/example/.qivryn/agents/worktrees/a1/extensions/cli/AGENTS.md";
    (walkDirs as any).mockResolvedValue([
      "file:///workspace/rules.md",
      copiedRule,
    ]);

    const { rules } = await loadCodebaseRules(mockIde);

    expect(rules).toHaveLength(1);
    expect(mockIde.readFile).not.toHaveBeenCalledWith(copiedRule);
  });

  it("does not read agent files from the broad codebase walk", async () => {
    const rootAgents = "file:///workspace/AGENTS.md";
    const nestedAgents = "file:///workspace/docs/AGENTS.md";
    (walkDirs as any).mockResolvedValue([
      "file:///workspace/rules.md",
      "file:///workspace/src/rules.md",
      rootAgents,
      nestedAgents,
    ]);

    const { rules } = await loadCodebaseRules(mockIde);

    expect(rules).toHaveLength(1);
    expect(mockIde.readFile).toHaveBeenCalledWith("file:///workspace/rules.md");
    expect(mockIde.readFile).not.toHaveBeenCalledWith(
      "file:///workspace/src/rules.md",
    );
    expect(mockIde.readFile).not.toHaveBeenCalledWith(rootAgents);
    expect(mockIde.readFile).not.toHaveBeenCalledWith(nestedAgents);
  });

  it("should handle errors when walkDirs fails", async () => {
    // Setup mock to throw
    (walkDirs as any).mockRejectedValue(
      new Error("Failed to walk directories"),
    );
    const { rules, errors } = await loadCodebaseRules(mockIde);

    // Should return no rules
    expect(rules).toHaveLength(0);

    // Should have one error
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Error loading colocated rule files");
  });
});
