import type { MessageContent, RuleWithSource, Tool } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  isSimpleConversationalPrompt,
  messageContentToText,
  selectPromptRelevantTools,
} from "./promptIntent";

const LOCAL_MLX_LARGE_RULE_CHARS = 4_000;

const SR_NUMBER_PATTERN = /\b[34]-\d{10}\b/i;
const MOSFS_PROMPT_PATTERN = /(?:^|[\s(["'`])\$mosfs\b|\bmosfs\b/i;
const EXPLICIT_SKILL_PROMPT_PATTERN =
  /(?:^|[\s(["'`])\$[A-Za-z][A-Za-z0-9_-]*(?=\b)/;
const REPO_REVIEW_PROMPT_PATTERN =
  /\b(codebase|current repo|diff|file|grep|inspect|read|repo|review|search|workspace)\b/i;

const COMPACT_MLX_MOSFS_RULE = `\
# MOSFS compact rule for local MLX

- For MOSFS SR review or summary, fetch live SR data before answering.
- SR detail command: python3 /Users/amridha/.codex/skills/mosfs/scripts/fetch_sr.py <SR_NUMBER>
- Parent, child, collab, or related SR command: python3 /Users/amridha/.codex/skills/mosfs/scripts/fetch_sr.py -r <SR_NUMBER>
- Summarize only from fetched output. If the fetch fails, report the exact error.
- Do not post, update, assign, resolve, close, or change an SR unless the user explicitly asks for that write and the normal dry-run and confirmation gates pass.`;

const COMPACT_MLX_GLOBAL_RULE = `\
# Qivryn compact local-agent rule

- Ground factual claims in visible workspace files, user context, command output, fetched live data, or official sources.
- Use available tools before making repository, support, SR, database, or current-state claims.
- Do not change files or external systems unless the user asked for that change and validation is possible.
- Preserve exact identifiers, paths, commands, dates, SR numbers, table names, and quoted text.
- Keep progress and final responses concise.`;

function normalizedText(content: MessageContent | undefined): string {
  return messageContentToText(content).replace(/\s+/g, " ").trim();
}

function toolByName(tools: Tool[], names: Set<string>): Tool[] {
  return tools.filter((tool) => names.has(tool.function.name));
}

export function isLocalMlxSupportPrompt(content: MessageContent | undefined) {
  const text = normalizedText(content);
  return (
    !!text && (MOSFS_PROMPT_PATTERN.test(text) || SR_NUMBER_PATTERN.test(text))
  );
}

export function selectLocalMlxPromptRelevantTools(
  tools: Tool[],
  content: MessageContent | undefined,
): Tool[] {
  if (tools.length === 0 || isSimpleConversationalPrompt(content)) {
    return [];
  }

  const selected = selectPromptRelevantTools(tools, content);
  const text = normalizedText(content);

  if (isLocalMlxSupportPrompt(content)) {
    return toolByName(
      selected,
      new Set<string>([BuiltInToolNames.RunTerminalCommand]),
    );
  }

  if (EXPLICIT_SKILL_PROMPT_PATTERN.test(text)) {
    return toolByName(
      selected,
      new Set<string>([
        BuiltInToolNames.ReadSkill,
        BuiltInToolNames.RunTerminalCommand,
      ]),
    );
  }

  if (REPO_REVIEW_PROMPT_PATTERN.test(text)) {
    return toolByName(
      selected,
      new Set<string>([
        BuiltInToolNames.FileGlobSearch,
        BuiltInToolNames.GrepSearch,
        BuiltInToolNames.ReadFile,
        BuiltInToolNames.ViewDiff,
      ]),
    );
  }

  return selected;
}

function ruleIdentifier(rule: RuleWithSource): string {
  return [
    rule.name,
    rule.slug,
    rule.description,
    rule.sourceFile,
    rule.rule.slice(0, 300),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function isMosfsRule(rule: RuleWithSource): boolean {
  const identifier = ruleIdentifier(rule);
  return (
    identifier.includes("mosfs") ||
    identifier.includes("/skills/mosfs/") ||
    identifier.includes("\\skills\\mosfs\\")
  );
}

function isAgentInstructionRule(rule: RuleWithSource): boolean {
  const sourceFile = (rule.sourceFile ?? "").toLowerCase();
  return (
    rule.source === "agentFile" ||
    sourceFile.endsWith("/agents.md") ||
    sourceFile.endsWith("/agent.md") ||
    sourceFile.endsWith("/codex.md") ||
    sourceFile.endsWith("/claude.md")
  );
}

function compactGenericLargeRule(rule: RuleWithSource): string {
  const name = rule.name ?? rule.slug ?? rule.sourceFile ?? "large rule";
  const description = rule.description?.trim();
  return `# ${name} compact rule for local MLX

${description ? `${description}\n\n` : ""}The full rule is large, so Qivryn compacted it for local MLX. Follow the rule title and description. If exact wording is required before acting, read the specific rule or skill with the available tool first.`;
}

export function compactRulesForLocalMlxRequest(
  rules: RuleWithSource[],
  content: MessageContent | undefined,
): RuleWithSource[] {
  if (rules.length === 0 || isSimpleConversationalPrompt(content)) {
    return [];
  }

  const supportPrompt = isLocalMlxSupportPrompt(content);

  return rules.map((rule) => {
    if (supportPrompt && isMosfsRule(rule)) {
      return {
        ...rule,
        rule: COMPACT_MLX_MOSFS_RULE,
      };
    }

    if (rule.rule.length <= LOCAL_MLX_LARGE_RULE_CHARS) {
      return rule;
    }

    if (isAgentInstructionRule(rule)) {
      return {
        ...rule,
        rule: COMPACT_MLX_GLOBAL_RULE,
      };
    }

    return {
      ...rule,
      rule: compactGenericLargeRule(rule),
    };
  });
}
