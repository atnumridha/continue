import { ConfigValidationError, markdownToRule } from "@qivryn/config-yaml";
import { IDE, RuleWithSource } from "../..";
import { walkDirs } from "../../indexing/walkDir";
import { RULES_MARKDOWN_FILENAME } from "../../llm/rules/constants";
import { findUriInDirs, getUriPathBasename } from "../../util/uri";
import { getDisabledCodexImportSourcePaths } from "../codex/codexImportManager";

export function isCodebaseRulesFile(fileUri: string): boolean {
  const normalized = fileUri.replaceAll("\\", "/").toLowerCase();
  const filename = getUriPathBasename(normalized).toLowerCase();
  return filename === RULES_MARKDOWN_FILENAME;
}

export function isRootOrDotQivrynRuleFile(
  fileUri: string,
  workspaceDirs: string[],
): boolean {
  if (!isCodebaseRulesFile(fileUri)) {
    return false;
  }

  const { relativePathOrBasename, foundInDir } = findUriInDirs(
    fileUri,
    workspaceDirs,
  );
  if (!foundInDir) {
    return false;
  }

  const normalizedRelativePath = relativePathOrBasename
    .replaceAll("\\", "/")
    .toLowerCase();
  return (
    normalizedRelativePath === RULES_MARKDOWN_FILENAME ||
    normalizedRelativePath.startsWith(".qivryn/")
  );
}

/**
 * Qivryn keeps ephemeral agent worktrees below its own data directory. When
 * that directory is opened as a VS Code workspace, those worktrees are not
 * user project source and must not contribute their copied agent rules.
 */
export function isQivrynInternalAgentWorktreePath(fileUri: string): boolean {
  return fileUri
    .replaceAll("\\", "/")
    .toLowerCase()
    .includes("/.qivryn/agents/worktrees/");
}

export class CodebaseRulesCache {
  private static instance: CodebaseRulesCache | null = null;
  private constructor() {}

  public static getInstance(): CodebaseRulesCache {
    if (CodebaseRulesCache.instance === null) {
      CodebaseRulesCache.instance = new CodebaseRulesCache();
    }
    return CodebaseRulesCache.instance;
  }
  rules: RuleWithSource[] = [];
  errors: ConfigValidationError[] = [];
  async refresh(ide: IDE) {
    const { rules, errors } = await loadCodebaseRules(ide);
    this.rules = rules;
    this.errors = errors;
  }
  async update(ide: IDE, uri: string) {
    const workspaceDirs = await ide.getWorkspaceDirs();
    if (
      !isRootOrDotQivrynRuleFile(uri, workspaceDirs) ||
      isQivrynInternalAgentWorktreePath(uri)
    ) {
      this.remove(uri);
      return;
    }

    const content = await ide.readFile(uri);
    const { relativePathOrBasename, foundInDir } = findUriInDirs(
      uri,
      workspaceDirs,
    );
    if (!foundInDir) {
      console.warn(
        `Failed to load codebase rule ${uri}: URI not found in workspace`,
      );
    }
    const rule = markdownToRule(
      content,
      {
        uriType: "file",
        fileUri: uri,
      },
      relativePathOrBasename,
    );
    const ruleWithSource: RuleWithSource = {
      ...rule,
      source: "colocated-markdown",
      sourceFile: uri,
    };
    const matchIdx = this.rules.findIndex((r) => r.sourceFile === uri);
    if (matchIdx === -1) {
      this.rules.push(ruleWithSource);
    } else {
      this.rules[matchIdx] = ruleWithSource;
    }
  }
  remove(uri: string) {
    this.rules = this.rules.filter((r) => r.sourceFile !== uri);
  }
}

/**
 * Loads root-level rules.md files and rules.md files under .qivryn.
 */
export async function loadCodebaseRules(ide: IDE): Promise<{
  rules: RuleWithSource[];
  errors: ConfigValidationError[];
}> {
  const errors: ConfigValidationError[] = [];
  const rules: RuleWithSource[] = [];

  try {
    // Root-level agent files are loaded by loadMarkdownRules. This walk must
    // not import nested AGENTS.md/CODEX.md files or recursively widen prompt
    // instructions from arbitrary project subdirectories.
    const allFiles = await walkDirs(ide);
    const workspaceDirs = await ide.getWorkspaceDirs();

    const disabled = await getDisabledCodexImportSourcePaths("rule");
    const rulesMdFiles = allFiles.filter(
      (file) =>
        isRootOrDotQivrynRuleFile(file, workspaceDirs) &&
        !isQivrynInternalAgentWorktreePath(file) &&
        !disabled.has(file),
    );

    // Process each rules.md file
    for (const filePath of rulesMdFiles) {
      try {
        const content = await ide.readFile(filePath);
        const { relativePathOrBasename, foundInDir, uri } = findUriInDirs(
          filePath,
          workspaceDirs,
        );
        if (foundInDir) {
          const lastSlashIndex = relativePathOrBasename.lastIndexOf("/");
          const parentDir = relativePathOrBasename.substring(0, lastSlashIndex);
          const rule = markdownToRule(
            content,
            {
              uriType: "file",
              fileUri: uri,
            },
            parentDir,
          );

          rules.push({
            ...rule,
            source: "colocated-markdown",
            sourceFile: filePath,
          });
        } else {
          const rule = markdownToRule(content, {
            uriType: "file",
            fileUri: filePath,
          });
          rules.push({
            ...rule,
            alwaysApply: rule.alwaysApply ?? true,
            source: "colocated-markdown",
            sourceFile: filePath,
          });
        }
      } catch (e) {
        errors.push({
          fatal: false,
          message: `Failed to parse colocated rule file ${filePath}: ${e instanceof Error ? e.message : e}`,
        });
      }
    }
  } catch (e) {
    errors.push({
      fatal: false,
      message: `Error loading colocated rule files: ${e instanceof Error ? e.message : e}`,
    });
  }

  return { rules, errors };
}
