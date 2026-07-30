import { describe, expect, test } from "vitest";

import Mlx, { getMlxServerLaunchConfig } from "./Mlx.js";

describe("Mlx", () => {
  test("builds Qivryn MLX bridge launch args for managed models", () => {
    const previousPython = process.env.QIVRYN_MLX_PYTHON;
    process.env.QIVRYN_MLX_PYTHON = "/custom/bin/python";

    try {
      const launchConfig = getMlxServerLaunchConfig(
        "mlx-community/gemma-4-12B-it-4bit",
        9090,
      );

      expect(launchConfig?.command).toBe("/custom/bin/python");
      expect(launchConfig?.args.slice(0, 3)).toEqual([
        "-u",
        "-c",
        expect.stringContaining("from mlx_lm.server import main"),
      ]);
      expect(launchConfig?.args.slice(-6)).toEqual([
        "--model",
        "mlx-community/gemma-4-12B-it-4bit",
        "--host",
        "127.0.0.1",
        "--port",
        "9090",
      ]);
      expect(launchConfig?.displayCommand).toContain(
        "/custom/bin/python -u -c <qivryn-mlx-bridge>",
      );
      expect(launchConfig?.apiBase).toBe("http://127.0.0.1:9090/v1/");
      expect(launchConfig?.endpoint).toEqual(
        new URL("http://127.0.0.1:9090/v1/models"),
      );
      expect(launchConfig?.logFile).toEqual(expect.any(String));
    } finally {
      if (previousPython === undefined) {
        delete process.env.QIVRYN_MLX_PYTHON;
      } else {
        process.env.QIVRYN_MLX_PYTHON = previousPython;
      }
    }
  });

  test("uses an explicit external API base when one is configured", () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
      apiBase: "https://example.com",
    });

    expect(mlx.apiBase).toBe("https://example.com/v1/");
  });

  test("does not build a managed MLX bridge launch config without a concrete model", () => {
    expect(getMlxServerLaunchConfig("", 8080)).toBeUndefined();
  });

  test("builds valid launch args for IPv6 localhost bridge ports", () => {
    const launchConfig = getMlxServerLaunchConfig(
      "mlx-community/gemma-4-12B-it-4bit",
      8080,
      "::1",
    );

    expect(launchConfig?.args.slice(-6)).toEqual([
      "--model",
      "mlx-community/gemma-4-12B-it-4bit",
      "--host",
      "::1",
      "--port",
      "8080",
    ]);
    expect(launchConfig?.host).toBe("::1");
    expect(launchConfig?.port).toBe(8080);
    expect(launchConfig?.apiBase).toBe("http://[::1]:8080/v1/");
    expect(launchConfig?.endpoint).toEqual(
      new URL("http://[::1]:8080/v1/models"),
    );
  });

  test("normalizes explicit external apiBase to the MLX OpenAI-compatible /v1 path", () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
      apiBase: "http://127.0.0.1:9090",
    });

    expect(mlx.apiBase).toBe("http://127.0.0.1:9090/v1/");
  });

  test("treats the old fixed 8080 MLX apiBase as Qivryn-managed", () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
      apiBase: "http://127.0.0.1:8080/v1/",
    });

    expect(mlx.apiBase).toBeUndefined();
  });

  test("uses the known Gemma 4 MLX context length", () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
    });

    expect(mlx.contextLength).toBe(262_144);
  });

  test("uses OpenAI-compatible chat messages instead of local Gemma prompt templating", async () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
      apiBase: "http://127.0.0.1:9090/v1/",
    });
    const sentBodies: any[] = [];
    const tool = {
      type: "function" as const,
      function: {
        name: "file_glob_search",
        description: "Search files",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
          },
          required: ["pattern"],
        },
      },
    } as any;

    (mlx as any).fetch = async (_url: URL, init: RequestInit) => {
      sentBodies.push(JSON.parse(String(init.body)));
      return new Response(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                role: "assistant",
                content: "ok",
              },
            },
          ],
        })}\n\n`,
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    };

    const chunks = [];
    for await (const chunk of mlx.streamChat(
      [
        { role: "system", content: "You are an agent." },
        { role: "user", content: "Review the current repo" },
      ],
      new AbortController().signal,
      { tools: [tool] },
    )) {
      chunks.push(chunk);
    }

    expect((mlx as any).templateMessages).toBeUndefined();
    expect(sentBodies[0].messages).toEqual([
      { role: "system", content: "You are an agent." },
      { role: "user", content: "Review the current repo" },
    ]);
    expect(sentBodies[0].tools?.[0]?.function?.name).toBe("file_glob_search");
    expect(sentBodies[0].tool_choice).toBe("auto");
    expect(chunks).toEqual([{ role: "assistant", content: "ok" }]);
  });

  test("disables Gemma and Qwen thinking templates by default", () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
    });

    const body = (mlx as any).modifyChatBody({
      model: "mlx-community/gemma-4-12B-it-4bit",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      max_tokens: 1024,
    });

    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  test("lets explicit chat_template_kwargs override the default", () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
      requestOptions: {
        extraBodyProperties: {
          chat_template_kwargs: {
            enable_thinking: true,
          },
        },
      },
    });

    const body = (mlx as any).modifyChatBody({
      model: "mlx-community/gemma-4-12B-it-4bit",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      max_tokens: 1024,
    });

    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  test("strips native tool payloads unless tool support is explicitly enabled", () => {
    const mlx = new Mlx({
      model: "mlx-community/unknown-model-4bit",
    });

    const body = (mlx as any).modifyChatBody({
      model: "mlx-community/unknown-model-4bit",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      max_tokens: 1024,
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            parameters: { type: "object" },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "read_file" },
      },
    });

    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  test("preserves native tool payloads for known MLX tool-capable models", () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
    });

    const tool = {
      type: "function",
      function: {
        name: "read_file",
        parameters: { type: "object" },
      },
    };
    const toolChoice = {
      type: "function",
      function: { name: "read_file" },
    };

    const body = (mlx as any).modifyChatBody({
      model: "mlx-community/gemma-4-12B-it-4bit",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      max_tokens: 1024,
      tools: [tool],
      tool_choice: toolChoice,
    });

    expect(body.tools).toEqual([tool]);
    expect(body.tool_choice).toEqual(toolChoice);
  });

  test("sets automatic MLX tool choice when tools are present", () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
    });

    const body = (mlx as any).modifyChatBody({
      model: "mlx-community/gemma-4-12B-it-4bit",
      messages: [{ role: "user", content: "review" }],
      stream: true,
      max_tokens: 1024,
      tools: [
        {
          type: "function",
          function: {
            name: "file_glob_search",
            parameters: { type: "object" },
          },
        },
      ],
    });

    expect(body.tool_choice).toBe("auto");
  });

  test("honors explicit tool support disablement", () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
      capabilities: { tools: false },
    });

    const body = (mlx as any).modifyChatBody({
      model: "mlx-community/gemma-4-12B-it-4bit",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      max_tokens: 1024,
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            parameters: { type: "object" },
          },
        },
      ],
    });

    expect(body.tools).toBeUndefined();
  });

  test("sends MLX chat template kwargs on streaming chat requests and reads reasoning-only deltas as content", async () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
      apiBase: "http://127.0.0.1:9090/v1/",
    });
    const sentBodies: any[] = [];
    (mlx as any).fetch = async (_url: URL, init: RequestInit) => {
      sentBodies.push(JSON.parse(String(init.body)));
      return new Response(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                role: "assistant",
                reasoning: "Hello from MLX",
              },
            },
          ],
        })}\n\n`,
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    };

    const chunks = [];
    for await (const chunk of (mlx as any)._streamChat(
      [{ role: "user", content: "Say hello" }],
      new AbortController().signal,
      mlx.completionOptions,
    )) {
      chunks.push(chunk);
    }

    expect(sentBodies[0].chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
    expect(chunks).toEqual([
      {
        role: "assistant",
        content: "Hello from MLX",
      },
    ]);
  });

  test("reads reasoning-only non-streaming MLX messages as assistant content", async () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
      apiBase: "http://127.0.0.1:9090/v1/",
    });
    (mlx as any).fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                reasoning: "Hello from non-streaming MLX",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const chunks = [];
    for await (const chunk of (mlx as any)._streamChat(
      [{ role: "user", content: "Say hello" }],
      new AbortController().signal,
      {
        ...mlx.completionOptions,
        stream: false,
      },
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        role: "assistant",
        content: "Hello from non-streaming MLX",
      },
    ]);
  });

  test("reads non-streaming MLX tool calls with OpenAI snake_case fields", async () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
      apiBase: "http://127.0.0.1:9090/v1/",
    });
    (mlx as any).fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "file_glob_search",
                      arguments: '{"pattern":"*"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const chunks = [];
    for await (const chunk of (mlx as any)._streamChat(
      [{ role: "user", content: "Review repo" }],
      new AbortController().signal,
      {
        ...mlx.completionOptions,
        stream: false,
      },
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "file_glob_search",
              arguments: '{"pattern":"*"}',
            },
          },
        ],
      },
    ]);
  });

  test("retries an empty MLX stream once without streaming", async () => {
    const mlx = new Mlx({
      model: "mlx-community/gemma-4-12B-it-4bit",
      apiBase: "http://127.0.0.1:9090/v1/",
    });
    const sentBodies: any[] = [];
    (mlx as any).fetch = async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sentBodies.push(body);
      if (body.stream === false) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "Recovered without streaming",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              delta: { role: "assistant" },
            },
          ],
        })}\n\ndata: [DONE]\n\n`,
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    };

    const chunks = [];
    for await (const chunk of (mlx as any)._streamChat(
      [{ role: "user", content: "Review repo" }],
      new AbortController().signal,
      mlx.completionOptions,
    )) {
      chunks.push(chunk);
    }

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0].stream).toBe(true);
    expect(sentBodies[1].stream).toBe(false);
    expect(chunks).toEqual([
      { role: "assistant", content: "Recovered without streaming" },
    ]);
  });
});
