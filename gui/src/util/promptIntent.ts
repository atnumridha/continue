import type { MessageContent, Tool } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { stripImages } from "core/util/messageContent";

const AGENTIC_PROMPT_PATTERN =
  /\b(apply|branch|build|change|class|code|codebase|commit|debug|diff|edit|error|file|find|fix|grep|implement|inspect|install|issue|log|method|open|patch|push|read|repo|review|root cause|run|search|test|terminal|trace|workspace)\b/i;

const SIMPLE_CONVERSATION_PATTERNS = [
  /^(hi|hello|hey|yo|thanks|thank you|ok|okay|cool|great|nice)[.!?\s]*$/i,
  /^(good morning|good afternoon|good evening)[.!?\s]*$/i,
  /^how are you[.!?\s]*$/i,
  /^who are you[.!?\s]*$/i,
  /^what can you do[.!?\s]*$/i,
];

const DISCOVERY_TOOL_NAMES = new Set<string>([
  BuiltInToolNames.ReadFile,
  BuiltInToolNames.ReadFileRange,
  BuiltInToolNames.FileGlobSearch,
  BuiltInToolNames.GrepSearch,
  BuiltInToolNames.ViewDiff,
  BuiltInToolNames.ReadLints,
]);

const MUTATION_TOOL_NAMES = new Set<string>([
  BuiltInToolNames.EditExistingFile,
  BuiltInToolNames.SingleFindAndReplace,
  BuiltInToolNames.MultiEdit,
  BuiltInToolNames.CreateNewFile,
  BuiltInToolNames.WriteFile,
  BuiltInToolNames.DeleteFile,
]);

const STRUCTURE_TOOL_NAMES = new Set<string>([
  BuiltInToolNames.LSTool,
  BuiltInToolNames.ViewRepoMap,
  BuiltInToolNames.ViewSubdirectory,
]);

const TERMINAL_TOOL_NAMES = new Set<string>([
  BuiltInToolNames.RunTerminalCommand,
]);

const WEB_TOOL_NAMES = new Set<string>([
  BuiltInToolNames.SearchWeb,
  BuiltInToolNames.FetchUrlContent,
]);

const BROWSER_TOOL_NAMES = new Set<string>([BuiltInToolNames.ComputerUse]);

const RULE_AND_SKILL_TOOL_NAMES = new Set<string>([
  BuiltInToolNames.RequestRule,
  BuiltInToolNames.ReadSkill,
  BuiltInToolNames.CreateRuleBlock,
]);

const PLANNING_TOOL_NAMES = new Set<string>([BuiltInToolNames.UpdatePlan]);

const LANGUAGE_TOOL_NAMES = new Set<string>([
  BuiltInToolNames.ReadCurrentlyOpenFile,
  BuiltInToolNames.GoToDefinition,
  BuiltInToolNames.SearchSymbols,
]);

const MUTATION_PROMPT_PATTERN =
  /\b(add|apply|change|create|delete|edit|fix|implement|modify|patch|refactor|remove|rename|replace|update|write)\b/i;
const STRUCTURE_PROMPT_PATTERN =
  /\b(list|ls|tree|structure|folders?|directories?|workspace layout)\b/i;
const TERMINAL_PROMPT_PATTERN =
  /\b(build|compile|command|gradle|install|lint|maven|mvn|npm|package|pnpm|run|shell|terminal|test|typecheck|vsix|yarn)\b/i;
const WEB_PROMPT_PATTERN =
  /\b(fetch|internet|online|url|web|website|docs?|documentation|https?:\/\/)\b/i;
const BROWSER_PROMPT_PATTERN =
  /\b(browser|click|dom|page|playwright|screenshot|ui|visual)\b/i;
const RULE_OR_SKILL_PROMPT_PATTERN =
  /\b(instruction|memory|remember|rule|rules|skill|skills)\b/i;
const EXPLICIT_SKILL_PROMPT_PATTERN =
  /(?:^|[\s(["'`])\$[A-Za-z][A-Za-z0-9_-]*(?=\b)/;
const SUPPORT_AUTOMATION_PROMPT_PATTERN =
  /\b(analysiscenter|attachments?|bugdb|customer uploaded|download(?:ed|ing)?|mosattachments|mosfs|read\s+(?:the\s+)?attachments?|service request|support request|sr\s+\d|4-\d{10})\b/i;
const PLAN_PROMPT_PATTERN = /\b(checklist|plan|steps|todo)\b/i;
const LANGUAGE_PROMPT_PATTERN =
  /\b(current file|definition|diagnostic|go to definition|lint|open file|symbol)\b/i;

export function messageContentToText(content: MessageContent | undefined) {
  if (!content) {
    return "";
  }
  return stripImages(content);
}

function addToolsForIntent(
  selectedNames: Set<string>,
  toolNames: Iterable<string>,
) {
  for (const toolName of toolNames) {
    selectedNames.add(toolName);
  }
}

export function isSimpleConversationalPrompt(
  content: MessageContent | undefined,
) {
  const text = messageContentToText(content).replace(/\s+/g, " ").trim();
  if (!text || text.length > 160) {
    return false;
  }
  if (AGENTIC_PROMPT_PATTERN.test(text)) {
    return false;
  }
  return SIMPLE_CONVERSATION_PATTERNS.some((pattern) => pattern.test(text));
}

export function selectPromptRelevantTools(
  tools: Tool[],
  content: MessageContent | undefined,
): Tool[] {
  if (tools.length === 0) {
    return tools;
  }

  const text = messageContentToText(content).replace(/\s+/g, " ").trim();
  if (!text) {
    return tools;
  }

  if (isSimpleConversationalPrompt(text)) {
    return [];
  }

  const selectedNames = new Set<string>(DISCOVERY_TOOL_NAMES);

  if (MUTATION_PROMPT_PATTERN.test(text)) {
    addToolsForIntent(selectedNames, MUTATION_TOOL_NAMES);
  }
  if (STRUCTURE_PROMPT_PATTERN.test(text)) {
    addToolsForIntent(selectedNames, STRUCTURE_TOOL_NAMES);
  }
  if (TERMINAL_PROMPT_PATTERN.test(text)) {
    addToolsForIntent(selectedNames, TERMINAL_TOOL_NAMES);
  }
  if (WEB_PROMPT_PATTERN.test(text)) {
    addToolsForIntent(selectedNames, WEB_TOOL_NAMES);
  }
  if (BROWSER_PROMPT_PATTERN.test(text)) {
    addToolsForIntent(selectedNames, BROWSER_TOOL_NAMES);
  }
  if (RULE_OR_SKILL_PROMPT_PATTERN.test(text)) {
    addToolsForIntent(selectedNames, RULE_AND_SKILL_TOOL_NAMES);
  }
  if (EXPLICIT_SKILL_PROMPT_PATTERN.test(text)) {
    selectedNames.add(BuiltInToolNames.ReadSkill);
    addToolsForIntent(selectedNames, TERMINAL_TOOL_NAMES);
  }
  if (SUPPORT_AUTOMATION_PROMPT_PATTERN.test(text)) {
    addToolsForIntent(selectedNames, RULE_AND_SKILL_TOOL_NAMES);
    addToolsForIntent(selectedNames, TERMINAL_TOOL_NAMES);
  }
  if (PLAN_PROMPT_PATTERN.test(text)) {
    addToolsForIntent(selectedNames, PLANNING_TOOL_NAMES);
  }
  if (LANGUAGE_PROMPT_PATTERN.test(text)) {
    addToolsForIntent(selectedNames, LANGUAGE_TOOL_NAMES);
  }

  return tools.filter((tool) => selectedNames.has(tool.function.name));
}
