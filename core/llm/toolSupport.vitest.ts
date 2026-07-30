import { describe, expect, test } from "vitest";

import { modelSupportsNativeTools, PROVIDER_TOOL_SUPPORT } from "./toolSupport";

describe("MLX tool support", () => {
  const supportsFn = PROVIDER_TOOL_SUPPORT["mlx"];

  test("enables native tools for local MLX Gemma 4 and Qwen3 models", () => {
    expect(supportsFn("mlx-community/gemma-4-12B-it-4bit")).toBe(true);
    expect(supportsFn("mlx-community/gemma4-12B-it-4bit")).toBe(true);
    expect(supportsFn("mlx-community/Qwen3-Coder-Next-4bit")).toBe(true);
    expect(supportsFn("mlx-community/qwen-3-coder-4bit")).toBe(true);
  });

  test("does not infer native tools for unknown MLX models", () => {
    expect(supportsFn("mlx-community/unknown-model-4bit")).toBe(false);
  });

  test("honors explicit model capability overrides before provider inference", () => {
    expect(
      modelSupportsNativeTools({
        provider: "mlx",
        model: "mlx-community/gemma-4-12B-it-4bit",
        capabilities: { tools: false },
      } as any),
    ).toBe(false);
    expect(
      modelSupportsNativeTools({
        provider: "mlx",
        model: "mlx-community/unknown-model-4bit",
        capabilities: { tools: true },
      } as any),
    ).toBe(true);
  });
});
