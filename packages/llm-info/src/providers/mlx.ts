import { ModelProvider } from "../types.js";

export const Mlx: ModelProvider = {
  models: [
    {
      model: "mlx-community/gemma-4-12B-it-4bit",
      displayName: "Gemma 4 12B IT 4-bit",
      contextLength: 262_144,
    },
    {
      model: "mlx-community/gemma-4-31B-it-qat-4bit",
      displayName: "Gemma 4 31B IT QAT 4-bit",
      contextLength: 262_144,
    },
    {
      model: "mlx-community/Qwen3-Coder-Next-4bit",
      displayName: "Qwen3 Coder Next 4-bit",
    },
  ],
  id: "mlx",
  displayName: "MLX",
};
