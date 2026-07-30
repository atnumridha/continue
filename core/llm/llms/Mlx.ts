import type {
  ChatCompletion,
  ChatCompletionCreateParams,
} from "openai/resources/index";
import { spawn, type ChildProcess } from "node:child_process";
import { streamSse } from "@qivryn/fetch";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type {
  ChatMessage,
  CompletionOptions,
  LLMFullCompletionOptions,
  LLMOptions,
  MessageOption,
  PromptLog,
} from "../../index.js";
import {
  fromChatCompletionChunk,
  fromChatResponse,
  LlmApiRequestType,
} from "../openaiTypeConverters.js";
import OpenAI from "./OpenAI.js";

const LEGACY_MLX_API_BASE = "http://127.0.0.1:8080/v1/";
const MANAGED_MLX_HOST = "127.0.0.1";
const GEMMA_4_CONTEXT_LENGTH = 262_144;
const MLX_SERVER_START_TIMEOUT_MS = 120_000;
const MLX_SERVER_PROBE_TIMEOUT_MS = 1_000;
const MLX_SERVER_PROBE_INTERVAL_MS = 500;

type MutableChatBody = ChatCompletionCreateParams & Record<string, any>;
type MlxBridgeLauncher = {
  command: string;
  argsPrefix: string[];
  displayName: string;
};
type MlxServerLaunchConfig = {
  command: string;
  args: string[];
  displayCommand: string;
  host: string;
  port: number;
  apiBase: string;
  endpoint: URL;
  logFile: string;
};
type MlxManagedServerState = MlxServerLaunchConfig & {
  child: ChildProcess;
};

const MLX_PYTHON_EXECUTABLE_CANDIDATES = [
  "/opt/miniconda3/bin/python",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/Library/Frameworks/Python.framework/Versions/3.14/bin/python3.14",
];

const MLX_SERVER_EXECUTABLE_CANDIDATES = [
  "/opt/miniconda3/bin/mlx_lm.server",
  "/opt/homebrew/bin/mlx_lm.server",
  "/usr/local/bin/mlx_lm.server",
  "mlx_lm.server",
];

const QIVRYN_MLX_BRIDGE_SCRIPT = [
  "import sys",
  "from mlx_lm.server import main",
  "sys.argv = ['qivryn-mlx-server'] + sys.argv[1:]",
  "main()",
].join("\n");

const mlxServerStartupPromises = new Map<
  string,
  Promise<MlxManagedServerState>
>();
const mlxServerProcesses = new Map<string, MlxManagedServerState>();

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeMlxApiBase(apiBase?: string): string | undefined {
  if (!apiBase) {
    return undefined;
  }

  try {
    const url = new URL(apiBase);
    const pathname = url.pathname.replace(/\/+$/, "");

    if (pathname.toLowerCase().endsWith("/v1")) {
      url.pathname = `${pathname}/`;
    } else {
      url.pathname = `${pathname}/v1/`;
    }

    return url.toString();
  } catch {
    return apiBase;
  }
}

function isLegacyMlxApiBase(apiBase?: string): boolean {
  return normalizeMlxApiBase(apiBase) === LEGACY_MLX_API_BASE;
}

function shouldUseManagedMlxServer(apiBase?: string): boolean {
  if (
    process.env.QIVRYN_MLX_USE_EXTERNAL_SERVER === "1" ||
    process.env.QIVRYN_MLX_AUTO_START === "0"
  ) {
    return false;
  }

  return !apiBase || isLegacyMlxApiBase(apiBase);
}

function isGemma4Model(model?: string): boolean {
  const lower = model?.toLowerCase() ?? "";
  return lower.includes("gemma-4") || lower.includes("gemma4");
}

function shouldSetEnableThinking(model?: string): boolean {
  const lower = model?.toLowerCase() ?? "";
  return (
    isGemma4Model(lower) || lower.includes("qwen3") || lower.includes("qwen-3")
  );
}

function supportsNativeTools(model?: string): boolean {
  const lower = model?.toLowerCase() ?? "";
  return (
    isGemma4Model(lower) || lower.includes("qwen3") || lower.includes("qwen-3")
  );
}

function inferCapabilities(options: LLMOptions): LLMOptions["capabilities"] {
  if (
    options.capabilities?.tools !== undefined ||
    !supportsNativeTools(options.model)
  ) {
    return options.capabilities;
  }

  return {
    ...options.capabilities,
    tools: true,
  };
}

function inferContextLength(model?: string): number | undefined {
  if (isGemma4Model(model)) {
    return GEMMA_4_CONTEXT_LENGTH;
  }
  return undefined;
}

function resolveKnownExecutable(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate.startsWith("/")) {
      return candidate;
    }

    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next known install location.
    }
  }

  return undefined;
}

function resolveMlxBridgeLauncher(): MlxBridgeLauncher {
  const configuredServerCommand = process.env.QIVRYN_MLX_LM_SERVER?.trim();
  if (configuredServerCommand) {
    return {
      command: configuredServerCommand,
      argsPrefix: [],
      displayName: configuredServerCommand,
    };
  }

  const configuredPythonCommand = process.env.QIVRYN_MLX_PYTHON?.trim();
  const pythonCommand =
    configuredPythonCommand ??
    resolveKnownExecutable(MLX_PYTHON_EXECUTABLE_CANDIDATES);

  if (pythonCommand) {
    return {
      command: pythonCommand,
      argsPrefix: ["-u", "-c", QIVRYN_MLX_BRIDGE_SCRIPT],
      displayName: `${pythonCommand} -u -c <qivryn-mlx-bridge>`,
    };
  }

  const serverCommand =
    resolveKnownExecutable(MLX_SERVER_EXECUTABLE_CANDIDATES) ?? "mlx_lm.server";
  return {
    command: serverCommand,
    argsPrefix: [],
    displayName: serverCommand,
  };
}

function getMlxServerLogFile(): string {
  const configuredLogFile = process.env.QIVRYN_MLX_LOG_FILE?.trim();
  if (configuredLogFile) {
    return configuredLogFile;
  }

  return path.join(os.homedir(), ".qivryn", "logs", "mlx_lm.server.log");
}

function appendMlxServerLog(logFile: string, message: string): void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, message);
  } catch {
    // Logging must never block model startup.
  }
}

function prependExecutablePath(command: string): string {
  const existingPath = process.env.PATH ?? "";
  const entries = [
    command.startsWith("/") ? path.dirname(command) : undefined,
    "/opt/miniconda3/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    existingPath,
  ].filter(Boolean);

  return entries.join(path.delimiter);
}

function shouldAutoStartMlxServer(): boolean {
  if (process.env.QIVRYN_MLX_AUTO_START === "0") {
    return false;
  }

  return (
    process.env.NODE_ENV !== "test" ||
    process.env.QIVRYN_MLX_AUTO_START_IN_TEST === "1"
  );
}

function getMlxServerEndpoint(apiBase: string): URL {
  return new URL("models", apiBase);
}

function formatHostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export function getMlxServerLaunchConfig(
  model: string,
  port: number,
  host = MANAGED_MLX_HOST,
): MlxServerLaunchConfig | undefined {
  if (!model.trim() || !Number.isInteger(port) || port <= 0) {
    return undefined;
  }

  const apiBase = `http://${formatHostForUrl(host)}:${port}/v1/`;
  const launcher = resolveMlxBridgeLauncher();
  const visibleArgs = [
    "--model",
    model,
    "--host",
    host,
    "--port",
    String(port),
  ];
  const args = [...launcher.argsPrefix, ...visibleArgs];

  return {
    command: launcher.command,
    args,
    displayCommand: `${launcher.displayName} ${visibleArgs.join(" ")}`,
    host,
    port,
    apiBase,
    endpoint: getMlxServerEndpoint(apiBase),
    logFile: getMlxServerLogFile(),
  };
}

async function findAvailableMlxServerPort(
  host = MANAGED_MLX_HOST,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a local MLX bridge port"));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function isMlxServerPortReachable({
  host,
  port,
}: MlxServerLaunchConfig): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const settle = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(MLX_SERVER_PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("MLX server startup was aborted"));
      return;
    }

    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("MLX server startup was aborted"));
      },
      { once: true },
    );
  });
}

function appendProcessOutput(current: string, data: Buffer): string {
  const next = current + data.toString();
  return next.length > 8_000 ? next.slice(-8_000) : next;
}

function getMlxReasoningText(value: Record<string, any>): string | undefined {
  const text = value.reasoning_content ?? value.reasoning;
  return typeof text === "string" && text.trim().length > 0 ? text : undefined;
}

function normalizeMlxReasoningOnlyChunk(value: any): any {
  const delta = value?.choices?.[0]?.delta;
  if (!isRecord(delta) || delta.content || delta.tool_calls) {
    return value;
  }

  const reasoningText = getMlxReasoningText(delta);
  if (!reasoningText) {
    return value;
  }

  return {
    ...value,
    choices: value.choices.map((choice: any, index: number) =>
      index === 0
        ? {
            ...choice,
            delta: {
              ...choice.delta,
              content: reasoningText,
              reasoning: undefined,
              reasoning_content: undefined,
              reasoning_details: undefined,
            },
          }
        : choice,
    ),
  };
}

function normalizeMlxReasoningOnlyMessage(message: any): any {
  if (!isRecord(message)) {
    return message;
  }

  const reasoningText = getMlxReasoningText(message);
  if (!reasoningText) {
    return {
      ...message,
      reasoning: undefined,
      reasoning_content: undefined,
      reasoning_details: undefined,
    };
  }

  if (message.content || message.tool_calls) {
    return message;
  }

  return {
    ...message,
    content: reasoningText,
    reasoning: undefined,
    reasoning_content: undefined,
    reasoning_details: undefined,
  };
}

function normalizeMlxChatCompletionResponse(data: any): ChatMessage[] {
  const choice = data?.choices?.[0];
  if (!choice?.message) {
    return [];
  }

  return fromChatResponse({
    ...data,
    choices: [
      {
        ...choice,
        message: normalizeMlxReasoningOnlyMessage(choice.message),
      },
    ],
  } as ChatCompletion);
}

function messageContentHasText(content: ChatMessage["content"]): boolean {
  if (!content) {
    return false;
  }

  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  return content.some((part) => {
    if (!isRecord(part)) {
      return false;
    }

    const text = (part as any).text;
    return typeof text === "string" && text.trim().length > 0;
  });
}

function isUsefulMlxOutput(message: ChatMessage): boolean {
  if (message.role === "assistant") {
    return (
      messageContentHasText(message.content) ||
      ((message as ChatMessage & { toolCalls?: unknown[] }).toolCalls?.length ??
        0) > 0
    );
  }

  if (message.role === "thinking") {
    return messageContentHasText(message.content);
  }

  return message.role === "tool" && messageContentHasText(message.content);
}

function buildEmptyMlxResponseError(): Error {
  return new Error(
    `MLX returned no text and no tool call after Qivryn retried the request without streaming. Check the local MLX log at ${getMlxServerLogFile()}.`,
  );
}

class Mlx extends OpenAI {
  static providerName = "mlx";
  static defaultOptions: Partial<LLMOptions> = {
    completionOptions: {
      model: "",
      maxTokens: 1024,
    },
  };

  protected useOpenAIAdapterFor: (LlmApiRequestType | "*")[] = [];

  private readonly useManagedMlxServer: boolean;

  constructor(options: LLMOptions) {
    const normalizedApiBase = normalizeMlxApiBase(options.apiBase);
    const useManagedMlxServer = shouldUseManagedMlxServer(normalizedApiBase);

    super({
      ...options,
      apiBase: useManagedMlxServer ? undefined : normalizedApiBase,
      contextLength: options.contextLength ?? inferContextLength(options.model),
      capabilities: inferCapabilities(options),
      template: options.template ?? "none",
    });

    this.useManagedMlxServer = useManagedMlxServer;
  }

  private getServerStartupKey(): string {
    return this.model.trim();
  }

  private async ensureMlxEndpointReady(signal: AbortSignal): Promise<boolean> {
    if (!this.useManagedMlxServer) {
      return false;
    }

    const model = this.model.trim();
    if (!model) {
      return false;
    }

    if (!shouldAutoStartMlxServer()) {
      return false;
    }

    const key = this.getServerStartupKey();
    const existingServer = mlxServerProcesses.get(key);
    if (existingServer) {
      if (await isMlxServerPortReachable(existingServer)) {
        this.apiBase = existingServer.apiBase;
        return true;
      }
      mlxServerProcesses.delete(key);
    }

    const existingStartup = mlxServerStartupPromises.get(key);
    if (existingStartup) {
      const state = await existingStartup;
      this.apiBase = state.apiBase;
      return true;
    }

    const startup = this.startManagedServer(model, signal);
    mlxServerStartupPromises.set(key, startup);
    try {
      const state = await startup;
      this.apiBase = state.apiBase;
      return true;
    } finally {
      mlxServerStartupPromises.delete(key);
    }
  }

  private async startManagedServer(
    model: string,
    signal: AbortSignal,
  ): Promise<MlxManagedServerState> {
    const port = await findAvailableMlxServerPort();
    const launchConfig = getMlxServerLaunchConfig(model, port);
    if (!launchConfig) {
      throw new Error(
        `Cannot start the Qivryn MLX bridge without a model name`,
      );
    }

    let stdout = "";
    let stderr = "";
    const child = spawn(launchConfig.command, launchConfig.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: prependExecutablePath(launchConfig.command),
        PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED ?? "1",
        HF_XET_HIGH_PERFORMANCE: process.env.HF_XET_HIGH_PERFORMANCE ?? "1",
      },
    });

    const state: MlxManagedServerState = { ...launchConfig, child };
    mlxServerProcesses.set(this.getServerStartupKey(), state);
    appendMlxServerLog(
      launchConfig.logFile,
      `\n[${new Date().toISOString()}] Starting ${launchConfig.displayCommand}\n`,
    );

    child.stdout?.on("data", (data: Buffer) => {
      stdout = appendProcessOutput(stdout, data);
      console.info(`[mlx_lm.server] ${data.toString().trimEnd()}`);
      appendMlxServerLog(launchConfig.logFile, data.toString());
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr = appendProcessOutput(stderr, data);
      console.info(`[mlx_lm.server] ${data.toString().trimEnd()}`);
      appendMlxServerLog(launchConfig.logFile, data.toString());
    });
    child.on("exit", () => {
      if (mlxServerProcesses.get(this.getServerStartupKey())?.child === child) {
        mlxServerProcesses.delete(this.getServerStartupKey());
      }
    });

    const startupStartedAt = Date.now();
    let exited:
      | { code: number | null; signal: NodeJS.Signals | null }
      | undefined;

    const processEventPromise = new Promise<void>((resolve, reject) => {
      child.once("error", (error) => {
        appendMlxServerLog(
          launchConfig.logFile,
          `[${new Date().toISOString()}] Failed to start: ${error.message}\n`,
        );
        reject(
          new Error(
            `Failed to start Qivryn's MLX bridge using "${launchConfig.displayCommand}": ${error.message}. Log: ${launchConfig.logFile}`,
          ),
        );
      });
      child.once("exit", (code, signalName) => {
        exited = { code, signal: signalName };
        appendMlxServerLog(
          launchConfig.logFile,
          `[${new Date().toISOString()}] Exited with code ${code ?? "unknown"}, signal ${signalName ?? "none"}\n`,
        );
        resolve();
      });
    });

    try {
      while (Date.now() - startupStartedAt < MLX_SERVER_START_TIMEOUT_MS) {
        if (signal.aborted) {
          throw new Error("MLX server startup was aborted");
        }

        if (await isMlxServerPortReachable(launchConfig)) {
          appendMlxServerLog(
            launchConfig.logFile,
            `[${new Date().toISOString()}] Ready on ${launchConfig.apiBase}\n`,
          );
          return state;
        }

        if (exited) {
          const output = [stdout.trim(), stderr.trim()]
            .filter(Boolean)
            .join("\n");
          throw new Error(
            `Qivryn's MLX bridge exited before port ${launchConfig.host}:${launchConfig.port} became reachable (code ${exited.code ?? "unknown"}, signal ${exited.signal ?? "none"}). Log: ${launchConfig.logFile}${output ? `\n\n${output}` : ""}`,
          );
        }

        await Promise.race([
          sleep(MLX_SERVER_PROBE_INTERVAL_MS, signal),
          processEventPromise,
        ]);
      }

      throw new Error(
        `Timed out waiting for Qivryn's MLX bridge on ${launchConfig.host}:${launchConfig.port}. Log: ${launchConfig.logFile}. Try starting MLX manually only for diagnosis: ${launchConfig.displayCommand}`,
      );
    } catch (error) {
      if (child.exitCode === null && !child.killed) {
        child.kill();
      }
      throw error;
    }
  }

  async *streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: LLMFullCompletionOptions = {},
    messageOptions?: MessageOption,
  ): AsyncGenerator<ChatMessage, PromptLog> {
    await this.ensureMlxEndpointReady(signal);

    const gen = super.streamChat(messages, signal, options, messageOptions);
    let next = await gen.next();
    while (!next.done) {
      yield next.value;
      next = await gen.next();
    }

    return next.value;
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    let body = this._convertArgs(options, messages);
    body = this.modifyChatBody(body);

    const response = await this.fetch(this._getEndpoint("chat/completions"), {
      method: "POST",
      headers: this._getHeaders(),
      body: JSON.stringify({
        ...body,
        ...this.extraBodyProperties(),
      }),
      signal,
    });

    if (body.stream === false) {
      if (response.status === 499) {
        return;
      }

      const data = await response.json();
      const messages = normalizeMlxChatCompletionResponse(data);
      if (!messages.some(isUsefulMlxOutput)) {
        throw buildEmptyMlxResponseError();
      }
      yield* messages;
      return;
    }

    let sawParsedChunk = false;
    let sawUsefulOutput = false;
    for await (const value of streamSse(response)) {
      const chunk = fromChatCompletionChunk(
        normalizeMlxReasoningOnlyChunk(value),
      );
      if (chunk) {
        sawParsedChunk = true;
        if (isUsefulMlxOutput(chunk)) {
          sawUsefulOutput = true;
        }

        if (!sawUsefulOutput && !isUsefulMlxOutput(chunk)) {
          continue;
        }

        yield chunk;
      }
    }

    if (sawParsedChunk && !sawUsefulOutput && !signal.aborted) {
      const retryResponse = await this.fetch(
        this._getEndpoint("chat/completions"),
        {
          method: "POST",
          headers: this._getHeaders(),
          body: JSON.stringify({
            ...body,
            stream: false,
            ...this.extraBodyProperties(),
          }),
          signal,
        },
      );

      if (retryResponse.status === 499) {
        return;
      }

      const data = await retryResponse.json();
      const messages = normalizeMlxChatCompletionResponse(data);
      if (!messages.some(isUsefulMlxOutput)) {
        throw buildEmptyMlxResponseError();
      }
      yield* messages;
    }
  }

  async listModels(): Promise<string[]> {
    if (!this.useManagedMlxServer) {
      return super.listModels();
    }

    if (!this.model.trim()) {
      return [];
    }

    await this.ensureMlxEndpointReady(new AbortController().signal);
    return super.listModels();
  }

  supportsFim(): boolean {
    return false;
  }

  supportsImages(): boolean {
    return this.capabilities?.uploadImage ?? false;
  }

  protected modifyChatBody(
    body: ChatCompletionCreateParams,
  ): ChatCompletionCreateParams {
    const next = super.modifyChatBody(body) as MutableChatBody;
    const extraBody = this.requestOptions?.extraBodyProperties;

    if (isRecord(extraBody)) {
      Object.assign(next, extraBody);
    }

    if (shouldSetEnableThinking(next.model ?? this.model)) {
      const existingTemplateArgs = isRecord(next.chat_template_kwargs)
        ? next.chat_template_kwargs
        : {};
      const configuredTemplateArgs = isRecord(extraBody?.chat_template_kwargs)
        ? extraBody.chat_template_kwargs
        : {};

      next.chat_template_kwargs = {
        ...existingTemplateArgs,
        enable_thinking: false,
        ...configuredTemplateArgs,
      };
    }

    if (next.tools?.length && next.tool_choice === undefined) {
      next.tool_choice = "auto";
    }

    if (!this.capabilities?.tools) {
      delete next.tools;
      delete next.tool_choice;
      delete next.parallel_tool_calls;
    }

    return next;
  }
}

export default Mlx;
