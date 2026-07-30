#!/usr/bin/env node
/**
 * sync-models.mjs
 *
 * Fetches live models from configured backends and writes ~/.qivryn/config.yaml.
 *
 * For models that support reasoning levels, ONE ENTRY PER REASONING LEVEL is
 * generated so the user can switch reasoning directly from Qivryn's model
 * picker (e.g. "Codex: GPT-5.6-Sol (high)" vs "Codex: GPT-5.6-Sol (max)").
 *
 * Run:  node ~/Documents/qivryn/scripts/sync-models.mjs
 * Auto: called by setup-qivryn-providers.sh on every invocation
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import * as YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CODEX_DIR = path.join(os.homedir(), ".codex");
const QIVRYN_DIR = path.join(os.homedir(), ".qivryn");
const COPILOT_AUTH_FILE = path.join(CODEX_DIR, "copilot-auth.json");
const CHATGPT_AUTH_FILE = path.join(CODEX_DIR, "auth.json");
const INSTALL_ID_FILE = path.join(CODEX_DIR, "installation_id");
const MODELS_CACHE_FILE = path.join(CODEX_DIR, "models_cache.json");
const CONFIG_SRC = path.join(__dirname, "..", ".qivryn-config", "config.yaml");
const CONFIG_DST = path.join(QIVRYN_DIR, "config.yaml");
const GLOBAL_CTX_FILE = path.join(QIVRYN_DIR, "index", "globalContext.json");
const MLX_DISCOVERY_API_BASE =
  process.env.QIVRYN_MLX_DISCOVERY_API_BASE?.trim() ||
  process.env.MLX_API_BASE?.trim() ||
  "";
const MLX_DEFAULT_MODEL = "mlx-community/gemma-4-12B-it-4bit";
const MLX_BUILT_IN_MODELS = [
  MLX_DEFAULT_MODEL,
  "mlx-community/Qwen3-Coder-Next-4bit",
];
const MLX_CONTEXT_LENGTH = 262_144;

const LEGACY_DEFAULT_RULES = new Set([
  "You are a precise software engineering assistant. Think carefully before making changes.",
  "Prefer minimal, targeted edits. Always explain your reasoning concisely.",
  "When using tools, be explicit about which file and line you are editing.",
]);

export function removeLegacyDefaultRules(config) {
  if (!Array.isArray(config?.rules)) return config;

  const rules = config.rules.filter(
    (rule) => typeof rule !== "string" || !LEGACY_DEFAULT_RULES.has(rule),
  );
  if (rules.length > 0) config.rules = rules;
  else delete config.rules;
  return config;
}

// Reasoning level labels shown in the model picker
const REASONING_LABELS = {
  none: "off",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra",
};

// For Codex backend: which level is the default (shown without a suffix)
const CODEX_DEFAULT_EFFORT = "medium";

// For Copilot: which level is the default
const COPILOT_DEFAULT_EFFORT = "medium";

// ── helpers ───────────────────────────────────────────────────────────────────
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function writePrivate(file, data) {
  const tmp = `${file}.sync.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function log(msg) {
  process.stderr.write(`  ${msg}\n`);
}

export function isGemma4Model(model) {
  return /(^|[/_-])gemma[-_]?4([/_-]|$)/i.test(model || "");
}

export function shouldDisableThinkingTemplate(model) {
  return (
    isGemma4Model(model) || /(^|[/_-])qwen[-_]?3([/_-]|$)/i.test(model || "")
  );
}

export function supportsNativeMlxTools(model) {
  return shouldDisableThinkingTemplate(model);
}

// ── Copilot bearer token refresh ──────────────────────────────────────────────
async function freshCopilotToken(auth) {
  const ghToken = auth.github_token || auth.githubAccessToken || "";
  const exp = Number(auth.expires_at || auth.expiresAt || 0);
  const now = Math.floor(Date.now() / 1000);
  if (auth.token && exp && exp - now > 300) return auth.token;
  if (!ghToken) return auth.token || auth.copilot_token || "";
  try {
    const res = await fetch(
      "https://api.github.com/copilot_internal/v2/token",
      {
        headers: {
          Authorization: `token ${ghToken}`,
          Accept: "application/json",
          "X-GitHub-Api-Version": "2025-04-01",
        },
      },
    );
    if (!res.ok) return auth.token || "";
    const envelope = await res.json();
    if (envelope.token) {
      const next = {
        ...auth,
        token: envelope.token,
        expires_at: Number(envelope.expires_at) || undefined,
        capi_base:
          envelope.endpoints?.api ||
          auth.capi_base ||
          "https://api.githubcopilot.com",
        capiBase:
          envelope.endpoints?.api ||
          auth.capiBase ||
          "https://api.githubcopilot.com",
        endpoints: envelope.endpoints || auth.endpoints || {},
      };
      writePrivate(COPILOT_AUTH_FILE, next);
      return envelope.token;
    }
  } catch {
    /* ignore */
  }
  return auth.token || "";
}

// ── Fetch Copilot models ──────────────────────────────────────────────────────
async function fetchCopilotModels() {
  const auth = readJson(COPILOT_AUTH_FILE);
  if (!auth) {
    log("Copilot auth not found — skipping");
    return [];
  }
  const token = await freshCopilotToken(auth);
  if (!token) {
    log("No Copilot token — skipping");
    return [];
  }
  const base = (
    auth.capiBase ||
    auth.capi_base ||
    auth.endpoints?.api ||
    "https://api.githubcopilot.com"
  ).replace(/\/+$/, "");
  const editorVersion =
    auth.editor_version || auth.editorVersion || "vscode/unknown";
  const pluginVersion =
    auth.editor_plugin_version ||
    auth.editorPluginVersion ||
    "copilot-chat/qivryn";
  try {
    const res = await fetch(`${base}/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": editorVersion,
        "Editor-Plugin-Version": pluginVersion,
        "X-GitHub-Api-Version": "2026-06-01",
        "OpenAI-Intent": "model-access",
        "X-Interaction-Type": "model-access",
      },
    });
    if (!res.ok) {
      log(`Copilot /models → ${res.status}`);
      return [];
    }
    const data = await res.json();
    const all = Array.isArray(data) ? data : data.data || [];
    return all.filter(
      (m) =>
        m.model_picker_enabled &&
        !m.id?.startsWith("text-embedding") &&
        m.id !== "trajectory-compaction",
    );
  } catch (e) {
    log(`Copilot fetch: ${e.message}`);
    return [];
  }
}

// ── Fetch ChatGPT Codex models ────────────────────────────────────────────────
async function fetchCodexModels() {
  const auth = readJson(CHATGPT_AUTH_FILE);
  if (!auth || auth.auth_mode !== "chatgpt") {
    log("ChatGPT auth not found — skipping");
    return [];
  }
  const token = auth.tokens?.access_token || "";
  if (!token) {
    log("No ChatGPT access token");
    return [];
  }
  const installId = fs.existsSync(INSTALL_ID_FILE)
    ? fs.readFileSync(INSTALL_ID_FILE, "utf8").trim()
    : "";
  const clientVersion =
    readJson(MODELS_CACHE_FILE)?.client_version || "0.140.0";
  try {
    const res = await fetch(
      `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(installId ? { "x-codex-installation-id": installId } : {}),
        },
      },
    );
    if (!res.ok) {
      log(`Codex /models → ${res.status}`);
      return [];
    }
    const data = await res.json();
    return (data.models || []).filter(
      (m) =>
        m.slug &&
        !["codex-auto-review", "trajectory-compaction"].includes(m.slug),
    );
  } catch (e) {
    log(`Codex fetch: ${e.message}`);
    return [];
  }
}

// ── Fetch local MLX models ───────────────────────────────────────────────────
async function fetchMlxModels() {
  if (!MLX_DISCOVERY_API_BASE) {
    return [];
  }

  try {
    const discoveryApiBase = MLX_DISCOVERY_API_BASE.endsWith("/")
      ? MLX_DISCOVERY_API_BASE
      : `${MLX_DISCOVERY_API_BASE}/`;
    const res = await fetch(new URL("models", discoveryApiBase), {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) {
      log(`MLX /models → ${res.status}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.data)
      ? data.data.map((m) => m.id || m.model).filter(Boolean)
      : [];
  } catch (e) {
    log(`MLX fetch: ${e.message}`);
    return [];
  }
}

// ── Model entry builders ──────────────────────────────────────────────────────

/** One config.yaml model entry, optionally locked to a specific reasoning level */
function makeEntry({
  name,
  provider,
  model,
  apiBase,
  contextLength,
  roles,
  capabilities,
  defaultCompletionOptions,
  requestOptions,
  reasoningEffort,
}) {
  const entry = {
    name,
    provider,
    model,
    apiBase,
    contextLength,
    roles,
    defaultCompletionOptions,
    requestOptions,
  };
  if (capabilities?.length) entry.capabilities = capabilities;
  if (reasoningEffort) {
    entry.requestOptions = {
      ...(entry.requestOptions || {}),
      extraBodyProperties: {
        ...(entry.requestOptions?.extraBodyProperties || {}),
        reasoning_effort: reasoningEffort,
      },
    };
  }
  return entry;
}

function copilotEntries(m) {
  const slug = m.id;
  const name = m.name || slug;
  const caps = m.capabilities?.supports || {};
  const reasoningLevels = caps.reasoning_effort || [];
  const hasTools = caps.tool_calls !== false;
  const hasVision = !!caps.vision;

  const roles = ["chat", "edit", "apply"];
  if (slug.includes("mini") || slug.includes("haiku") || slug.includes("flash"))
    roles.push("subagent");
  else roles.push("summarize");

  const capabilities = [];
  if (hasTools) capabilities.push("tool_use");
  if (hasVision) capabilities.push("image_input");

  const defaultEffort = reasoningLevels.includes(COPILOT_DEFAULT_EFFORT)
    ? COPILOT_DEFAULT_EFFORT
    : reasoningLevels[0] || null;

  const entry = makeEntry({
    name: `Copilot: ${name}`,
    provider: "github-copilot",
    model: slug,
    apiBase: "https://api.githubcopilot.com/",
    roles,
    capabilities,
    reasoningEffort: defaultEffort,
  });

  // Store available levels as metadata for the UI reasoning picker
  if (reasoningLevels.length > 0) {
    entry.requestOptions = {
      ...(entry.requestOptions || {}),
      extraBodyProperties: {
        ...(entry.requestOptions?.extraBodyProperties || {}),
        reasoning_effort: defaultEffort,
        _reasoningLevels: reasoningLevels,
      },
    };
  }

  return [entry];
}

function codexEntries(m) {
  const slug = m.slug;
  const name = m.display_name || slug;
  const reasoningLevels = (m.supported_reasoning_levels || [])
    .map((r) => (typeof r === "object" ? r.effort : r))
    .filter(Boolean);

  const roles = ["chat", "edit", "apply"];
  if (slug.includes("mini") || slug.includes("luna")) roles.push("subagent");
  else roles.push("summarize");

  const defaultEffort = reasoningLevels.includes(CODEX_DEFAULT_EFFORT)
    ? CODEX_DEFAULT_EFFORT
    : reasoningLevels[0] || null;

  const entry = makeEntry({
    name: `Codex: ${name}`,
    provider: "chatgpt-codex",
    model: slug,
    apiBase: "https://chatgpt.com/backend-api/codex/",
    roles,
    capabilities: ["tool_use", "image_input"],
    reasoningEffort: defaultEffort,
  });

  // Store available levels as metadata for the UI reasoning picker
  if (reasoningLevels.length > 0) {
    entry.requestOptions = {
      ...(entry.requestOptions || {}),
      extraBodyProperties: {
        ...(entry.requestOptions?.extraBodyProperties || {}),
        reasoning_effort: defaultEffort,
        _reasoningLevels: reasoningLevels,
      },
    };
  }

  return [entry];
}

export function mlxEntries(modelIds) {
  const models = new Set([...MLX_BUILT_IN_MODELS, ...modelIds]);

  return [...models].map((model) =>
    makeEntry({
      name:
        model === MLX_DEFAULT_MODEL
          ? "MLX: Gemma 4 12B"
          : `MLX: ${model.split("/").at(-1) || model}`,
      provider: "mlx",
      model,
      contextLength: isGemma4Model(model) ? MLX_CONTEXT_LENGTH : undefined,
      roles: ["chat", "edit", "apply", "summarize"],
      capabilities: supportsNativeMlxTools(model) ? ["tool_use"] : undefined,
      defaultCompletionOptions: {
        maxTokens: 1024,
      },
      requestOptions: shouldDisableThinkingTemplate(model)
        ? {
            extraBodyProperties: {
              chat_template_kwargs: {
                enable_thinking: false,
              },
            },
          }
        : undefined,
    }),
  );
}

function readExistingNonMlxModels() {
  try {
    const config = YAML.parse(fs.readFileSync(CONFIG_DST, "utf8"));
    return Array.isArray(config?.models)
      ? config.models.filter((m) => m?.provider !== "mlx")
      : [];
  } catch {
    return [];
  }
}

// ── Build full model list ─────────────────────────────────────────────────────
export async function buildModelList(copilotModels, codexModels, mlxModels) {
  const models = [];

  // ChatGPT Codex models (newest frontier first)
  for (const m of codexModels) {
    models.push(...codexEntries(m));
  }

  // Codex autocomplete — use the default (medium) entry of the smallest model
  const codexAutoBase =
    codexModels.find((m) => m.slug?.includes("mini")) ||
    codexModels.find((m) => m.slug?.includes("luna")) ||
    codexModels[0];
  if (codexAutoBase) {
    models.push(
      makeEntry({
        name: "Codex Autocomplete",
        provider: "chatgpt-codex",
        model: codexAutoBase.slug,
        apiBase: "https://chatgpt.com/backend-api/codex/",
        roles: ["autocomplete"],
        reasoningEffort: CODEX_DEFAULT_EFFORT,
      }),
    );
  }

  // GitHub Copilot models
  for (const m of copilotModels) {
    models.push(...copilotEntries(m));
  }

  // Copilot autocomplete
  const copilotAutoBase =
    copilotModels.find((m) => m.id === "gpt-5.4-mini") ||
    copilotModels.find((m) => m.id?.includes("mini")) ||
    copilotModels[0];
  if (copilotAutoBase) {
    models.push(
      makeEntry({
        name: "Copilot Autocomplete",
        provider: "github-copilot",
        model: copilotAutoBase.id,
        apiBase: "https://api.githubcopilot.com/",
        roles: ["autocomplete"],
      }),
    );
  }

  // Local MLX models. Keep the known Gemma 4 entry even when the server is not
  // running so the model remains selectable after install; live /v1/models adds
  // any other MLX models the local server reports.
  models.push(...mlxEntries(mlxModels));

  // OCA models (static)
  const ocaBase =
    "https://code-internal.aiservice.us-chicago-1.oci.oraclecloud.com/20250206/app/litellm/";
  models.push(
    makeEntry({
      name: "OCA: gpt-5.3-codex",
      provider: "oca",
      model: "oca/gpt-5.3-codex",
      apiBase: ocaBase,
      roles: ["chat", "edit", "apply"],
      capabilities: ["tool_use"],
    }),
    makeEntry({
      name: "OCA: gpt-4.1",
      provider: "oca",
      model: "oca/gpt-4.1",
      apiBase: ocaBase,
      roles: ["chat", "edit", "apply", "summarize"],
      capabilities: ["tool_use"],
    }),
    makeEntry({
      name: "OCA: gpt-4o",
      provider: "oca",
      model: "oca/gpt-4o",
      apiBase: ocaBase,
      roles: ["chat", "edit", "apply"],
      capabilities: ["tool_use"],
    }),
    makeEntry({
      name: "OCA: Grok 4.20 Reasoning",
      provider: "oca",
      model: "oca/grok4-20-reasoning",
      apiBase: ocaBase,
      contextLength: 2_000_000,
      roles: ["chat", "edit", "apply"],
      capabilities: ["tool_use"],
    }),
    makeEntry({
      name: "OCA: Grok 4.3",
      provider: "oca",
      model: "oca/grok4-3",
      apiBase: ocaBase,
      contextLength: 1_000_000,
      roles: ["chat", "edit", "apply"],
      capabilities: ["tool_use"],
    }),
    makeEntry({
      name: "OCA: Llama 4",
      provider: "oca",
      model: "oca/llama4",
      apiBase: ocaBase,
      contextLength: 1_000_000,
      roles: ["chat", "edit", "apply"],
      capabilities: ["tool_use"],
    }),
    makeEntry({
      name: "OCA Autocomplete",
      provider: "oca",
      model: "oca/gpt-4o-mini",
      apiBase: ocaBase,
      roles: ["autocomplete"],
    }),
  );

  return models;
}

// ── Write config.yaml ─────────────────────────────────────────────────────────
function writeConfig(models) {
  let base;
  try {
    base = YAML.parse(fs.readFileSync(CONFIG_DST, "utf8"));
  } catch {
    base = {};
  }

  base.name = "Qivryn — ChatGPT Codex, Copilot, OCA (auto-synced)";
  base.version = "1.0.0";
  base.schema = "v1";
  base.models = models.map((m) =>
    Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)),
  );
  removeLegacyDefaultRules(base);
  if (!base.context)
    base.context = [
      { provider: "code" },
      { provider: "docs" },
      { provider: "diff" },
      { provider: "terminal" },
      { provider: "problems" },
      { provider: "folder" },
      { provider: "codebase" },
    ];
  if (!base.env) base.env = ["OCA_API_KEY"];

  const yaml = YAML.stringify(base, {
    lineWidth: 140,
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
  });
  fs.mkdirSync(QIVRYN_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_DST, yaml);
  try {
    fs.mkdirSync(path.dirname(CONFIG_SRC), { recursive: true });
    fs.writeFileSync(CONFIG_SRC, yaml);
  } catch {
    /* ok */
  }
}

// ── Clear stale selections ────────────────────────────────────────────────────
function clearStaleSelections() {
  try {
    if (!fs.existsSync(GLOBAL_CTX_FILE)) return;
    const ctx = JSON.parse(fs.readFileSync(GLOBAL_CTX_FILE, "utf8"));
    ctx.selectedModelsByProfileId = {};
    fs.writeFileSync(GLOBAL_CTX_FILE, JSON.stringify(ctx, null, 2));
  } catch {
    /* ignore */
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log("Syncing models from live backends...");

  const [copilotModels, codexModels, mlxModels] = await Promise.all([
    fetchCopilotModels(),
    fetchCodexModels(),
    fetchMlxModels(),
  ]);

  log(`Copilot: ${copilotModels.length} picker models`);
  log(`ChatGPT Codex: ${codexModels.length} models`);
  log(`MLX: ${mlxModels.length} local models`);

  let models;
  if (copilotModels.length === 0 && codexModels.length === 0) {
    const existingModels = readExistingNonMlxModels();
    if (existingModels.length > 0) {
      log(
        `No remote models fetched — preserving ${existingModels.length} existing non-MLX entries`,
      );
      models = [...existingModels, ...mlxEntries(mlxModels)];
    } else {
      log("No remote models fetched — generating local/static entries only");
      models = await buildModelList(copilotModels, codexModels, mlxModels);
    }
  } else {
    models = await buildModelList(copilotModels, codexModels, mlxModels);
  }

  log(
    `Expanded to ${models.length} entries (including per-reasoning variants)`,
  );

  writeConfig(models);
  clearStaleSelections();
  log(`Written: ${CONFIG_DST}`);
  log("Reload VS Code (Developer: Reload Window) to apply");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((e) => {
    process.stderr.write(`sync-models error: ${e.message}\n`);
    process.exit(1);
  });
}
