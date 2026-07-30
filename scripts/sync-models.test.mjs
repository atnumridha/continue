import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelList,
  isGemma4Model,
  mlxEntries,
  removeLegacyDefaultRules,
  shouldDisableThinkingTemplate,
  supportsNativeMlxTools,
} from "./sync-models.mjs";

const legacyRules = [
  "You are a precise software engineering assistant. Think carefully before making changes.",
  "Prefer minimal, targeted edits. Always explain your reasoning concisely.",
  "When using tools, be explicit about which file and line you are editing.",
];

test("removes all legacy default rules", () => {
  const config = { rules: [...legacyRules] };

  assert.deepEqual(removeLegacyDefaultRules(config), {});
});

test("preserves custom string and structured rules", () => {
  const customRule = { name: "TypeScript", rule: "Use strict typing" };
  const config = {
    rules: [legacyRules[0], "Keep this custom rule", customRule],
  };

  assert.deepEqual(removeLegacyDefaultRules(config), {
    rules: ["Keep this custom rule", customRule],
  });
});

test("leaves configurations without a rules array unchanged", () => {
  const config = { name: "Example" };

  assert.strictEqual(removeLegacyDefaultRules(config), config);
  assert.deepEqual(config, { name: "Example" });
});

test("builds a selectable MLX Gemma 4 entry with large context and thinking disabled", () => {
  const [entry] = mlxEntries([]);

  assert.equal(entry.name, "MLX: Gemma 4 12B");
  assert.equal(entry.provider, "mlx");
  assert.equal(entry.model, "mlx-community/gemma-4-12B-it-4bit");
  assert.equal(entry.apiBase, undefined);
  assert.equal(entry.contextLength, 262_144);
  assert.deepEqual(entry.roles, ["chat", "edit", "apply", "summarize"]);
  assert.deepEqual(entry.capabilities, ["tool_use"]);
  assert.deepEqual(entry.defaultCompletionOptions, { maxTokens: 1024 });
  assert.deepEqual(entry.requestOptions, {
    extraBodyProperties: {
      chat_template_kwargs: {
        enable_thinking: false,
      },
    },
  });
});

test("dedupes the default MLX Gemma model from live model listing", () => {
  const entries = mlxEntries([
    "mlx-community/gemma-4-12B-it-4bit",
    "mlx-community/gemma-4-31B-it-qat-4bit",
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.model),
    [
      "mlx-community/gemma-4-12B-it-4bit",
      "mlx-community/Qwen3-Coder-Next-4bit",
      "mlx-community/gemma-4-31B-it-qat-4bit",
    ],
  );
  assert.equal(isGemma4Model("mlx-community/gemma-4-31B-it-qat-4bit"), true);
  assert.equal(
    shouldDisableThinkingTemplate("mlx-community/Qwen3-Coder-Next-4bit"),
    true,
  );
  assert.equal(
    supportsNativeMlxTools("mlx-community/Qwen3-Coder-Next-4bit"),
    true,
  );
});

test("includes built-in MLX code model when local server is not running", () => {
  const entries = mlxEntries([]);
  const qwen = entries.find(
    (entry) => entry.model === "mlx-community/Qwen3-Coder-Next-4bit",
  );

  assert.equal(qwen?.name, "MLX: Qwen3-Coder-Next-4bit");
  assert.deepEqual(qwen?.capabilities, ["tool_use"]);
  assert.deepEqual(qwen?.requestOptions, {
    extraBodyProperties: {
      chat_template_kwargs: {
        enable_thinking: false,
      },
    },
  });
});

test("sets requested OCA model context windows", async () => {
  const entries = await buildModelList([], [], []);
  const contextByModel = new Map(
    entries
      .filter((entry) =>
        [
          "oca/grok4-20-reasoning",
          "oca/grok4-3",
          "oca/llama4",
        ].includes(entry.model),
      )
      .map((entry) => [entry.model, entry.contextLength]),
  );

  assert.equal(contextByModel.get("oca/grok4-20-reasoning"), 2_000_000);
  assert.equal(contextByModel.get("oca/grok4-3"), 1_000_000);
  assert.equal(contextByModel.get("oca/llama4"), 1_000_000);
});
