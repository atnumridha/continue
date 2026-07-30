import { JSONContent } from "@tiptap/core";
import {
  AssistantChatMessage,
  ChatMessage,
  InputModifiers,
  PromptLog,
} from "core";
import { describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { streamResponseThunk } from "./streamResponse";

// Mock external dependencies only - let selectors run naturally
// Removed: modelSupportsNativeTools - let it run naturally

// Removed: addSystemMessageToolsToSystemMessage - let it run naturally

// Mock system message construction to keep test readable
vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(),
}));

import { getBaseSystemMessage } from "../util/getBaseSystemMessage";

// Removed: shouldAutoEnableSystemMessageTools - let it run naturally

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid-123"),
}));

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(),
  }),
);

import { ModelDescription, Tool } from "core";
import { serializeTool } from "core/tools";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  computerUseTool,
  editFileTool,
  grepSearchTool,
  readFileTool,
  runTerminalCommandTool,
} from "core/tools/definitions";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { newSession } from "../slices/sessionSlice";
import { RootState } from "../store";

const mockGetBaseSystemMessage = vi.mocked(getBaseSystemMessage);

const mockResolveEditorContent = vi.mocked(resolveEditorContent);

const mockClaudeModel: ModelDescription = {
  title: "Claude 3.5 Sonnet",
  model: "claude-3-5-sonnet-20241022",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  completionOptions: { reasoningBudgetTokens: 2048 },
};

const readSkillTestTool: Tool = {
  type: "function",
  displayTitle: "Read Skill",
  wouldLikeTo: "read a skill",
  isCurrently: "reading a skill",
  hasAlready: "read a skill",
  group: "Built-In",
  readonly: true,
  function: {
    name: BuiltInToolNames.ReadSkill,
    description: "Read an available skill before using it.",
    parameters: {
      type: "object",
      properties: {
        skillName: {
          type: "string",
        },
      },
      required: ["skillName"],
    },
  },
};

// Mock editor state (what user types in the input)
const mockEditorState: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Hello, please help me with this code" }],
    },
  ],
};

// Mock input modifiers (codebase context, etc.)
const mockModifiers: InputModifiers = {
  useCodebase: true,
  noContext: false,
};

export function getRootStateWithClaude(): RootState {
  const state = getEmptyRootState();
  return {
    ...state,
    config: {
      ...state.config,
      config: {
        ...state.config.config,
        selectedModelByRole: {
          ...state.config.config.selectedModelByRole,
          chat: mockClaudeModel,
        },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default mock for resolveEditorContent (can be overridden in individual tests)
  mockResolveEditorContent.mockResolvedValue({
    selectedContextItems: [],
    selectedCode: [],
    content: "Hello, please help me with this code",
    legacyCommandWithInput: undefined,
  });

  // Mock getBaseSystemMessage to return simple system message for readable tests
  mockGetBaseSystemMessage.mockReturnValue("You are a helpful assistant.");
});

describe("streamResponseThunk", () => {
  it("continues one conversation while another conversation is selected", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.id = "session-a";
    initialState.session.history = [];

    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;
    const getState = () => mockStore.getState() as RootState;
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    async function* streamA(): AsyncGenerator<
      AssistantChatMessage[],
      PromptLog | undefined
    > {
      yield [{ role: "assistant", content: "A1" }];
      await gateA;
      yield [{ role: "assistant", content: "A2" }];
      return undefined;
    }

    async function* streamB(): AsyncGenerator<
      AssistantChatMessage[],
      PromptLog | undefined
    > {
      yield [{ role: "assistant", content: "B1" }];
      await gateB;
      yield [{ role: "assistant", content: "B2" }];
      return undefined;
    }

    mockIdeMessenger.llmStreamChat = vi
      .fn()
      .mockImplementationOnce(() => streamA())
      .mockImplementationOnce(() => streamB());

    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2_000;
      while (!predicate()) {
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for conversation state");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    const runA = mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );
    await waitFor(() =>
      String(getState().session.history.at(-1)?.message.content).includes("A1"),
    );

    const controllerA = getState().session.streamAborter;
    mockStore.dispatch(
      newSession({
        sessionId: "session-b",
        title: "B",
        workspaceDirectory: "",
        history: [],
        mode: "agent",
        chatModelTitle: mockClaudeModel.title,
      }),
    );

    const runB = mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );
    await waitFor(() =>
      String(getState().session.history.at(-1)?.message.content).includes("B1"),
    );

    releaseA();
    await runA;

    const stateWhileBIsVisible = getState();
    expect(controllerA.signal.aborted).toBe(false);
    expect(stateWhileBIsVisible.session.id).toBe("session-b");
    expect(
      stateWhileBIsVisible.session.backgroundSessionStates?.[
        "session-a"
      ]?.history.at(-1)?.message.content,
    ).toBe("A1A2");
    expect(
      stateWhileBIsVisible.session.backgroundSessionStates?.["session-a"]
        ?.isStreaming,
    ).toBe(false);
    expect(stateWhileBIsVisible.session.isStreaming).toBe(true);
    expect(stateWhileBIsVisible.session.history.at(-1)?.message.content).toBe(
      "B1",
    );

    releaseB();
    await runB;
    mockStore.dispatch(
      newSession({
        sessionId: "session-a",
        title: "A",
        workspaceDirectory: "",
        history: [],
        mode: "agent",
        chatModelTitle: mockClaudeModel.title,
      }),
    );

    expect(getState().session.id).toBe("session-a");
    expect(getState().session.history.at(-1)?.message.content).toBe("A1A2");
  });

  it("serializes steering behind the interrupted stream for the same session", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.id = "steering-session";
    initialState.session.history = [];
    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;
    let releaseInitialStream!: () => void;
    const initialStreamGate = new Promise<void>((resolve) => {
      releaseInitialStream = resolve;
    });
    let streamCallCount = 0;

    async function* initialStream(): AsyncGenerator<
      AssistantChatMessage[],
      PromptLog | undefined
    > {
      yield [{ role: "assistant", content: "Partial answer" }];
      await initialStreamGate;
      yield [{ role: "assistant", content: " stale tail" }];
      return undefined;
    }

    async function* steeringStream(): AsyncGenerator<
      AssistantChatMessage[],
      PromptLog | undefined
    > {
      yield [{ role: "assistant", content: "Steered answer" }];
      return undefined;
    }

    mockIdeMessenger.llmStreamChat = vi.fn().mockImplementation(() => {
      streamCallCount += 1;
      return streamCallCount === 1 ? initialStream() : steeringStream();
    });

    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2_000;
      while (!predicate()) {
        if (Date.now() > deadline)
          throw new Error("Timed out waiting for stream");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    const initialRun = mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );
    await waitFor(() =>
      String(
        (mockStore.getState() as RootState).session.history.at(-1)?.message
          .content,
      ).includes("Partial answer"),
    );

    mockResolveEditorContent.mockResolvedValue({
      selectedContextItems: [],
      selectedCode: [],
      content: "Prioritize the failing tests",
      legacyCommandWithInput: undefined,
    });
    const steeringRun = mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
        steerActiveRun: true,
      }) as any,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    const queuedHistory = (mockStore.getState() as RootState).session.history;
    expect(streamCallCount).toBe(1);
    expect(queuedHistory.at(-1)?.message.role).toBe("user");
    releaseInitialStream();
    await initialRun;
    await steeringRun;

    const history = (mockStore.getState() as RootState).session.history;
    expect(streamCallCount).toBe(2);
    expect(history.map((item) => item.message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history[1].message.content).toBe("Partial answer");
    expect(history[2].message.role).toBe("user");
    expect(history[3].message.content).toBe("Steered answer");
  });

  it("should execute complete streaming flow with all dispatches", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    initialState.session.id = "session-123";
    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;

    mockIdeMessenger.responses["llm/compileChat"] = {
      compiledChatMessages: [{ role: "user", content: "Hello" }],
      didPrune: false,
      contextPercentage: 0.8,
    };
    const requestSpy = vi.spyOn(mockIdeMessenger, "request");
    const postSpy = vi.spyOn(mockIdeMessenger, "post");

    // Setup streaming generator
    async function* mockStreamGenerator(): AsyncGenerator<
      AssistantChatMessage[],
      PromptLog
    > {
      yield [{ role: "assistant", content: "First chunk" }];
      yield [{ role: "assistant", content: "Second chunk" }];
      return {
        prompt: "Hello",
        completion: "Hi there!",
        modelProvider: "anthropic",
        modelTitle: "Claude 3.5 Sonnet",
      };
    }

    const mockStreamChat = vi.fn();
    mockStreamChat.mockReturnValue(mockStreamGenerator());
    mockIdeMessenger.llmStreamChat = mockStreamChat;

    // Execute thunk
    const result = await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    // Verify exact sequence of dispatched actions with payloads
    const dispatchedActions = mockStore.getActions();

    expect(dispatchedActions).toEqual([
      {
        type: "chat/streamResponse/pending",
        meta: expect.objectContaining({
          arg: { editorState: mockEditorState, modifiers: mockModifiers },
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "chat/streamWrapper/pending",
        meta: expect.objectContaining({
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/submitEditorAndInitAtIndex",
        payload: {
          editorState: mockEditorState,
          index: 1,
        },
      },
      {
        type: "session/resetNextCodeBlockToApplyIndex",
        payload: undefined,
      },
      {
        type: "session/setSessionChatModelTitle",
        payload: "Claude 3.5 Sonnet",
      },
      {
        type: "symbols/updateFromContextItems/pending",
        meta: expect.objectContaining({
          arg: [],
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/updateHistoryItemAtIndex",
        payload: {
          index: 1,
          updates: {
            contextItems: [],
            message: {
              content: "Hello, please help me with this code",
              id: "mock-uuid-123",
              role: "user",
            },
          },
        },
      },
      {
        type: "chat/streamNormalInput/pending",
        meta: expect.objectContaining({
          arg: { legacySlashCommandData: undefined },
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/setAppliedRulesAtIndex",
        payload: {
          index: 1,
          appliedRules: [],
        },
      },
      {
        type: "session/setActive",
        payload: undefined,
      },
      {
        type: "session/setInlineErrorMessage",
        payload: undefined,
      },
      {
        type: "symbols/updateFromContextItems/fulfilled",
        meta: expect.objectContaining({
          arg: [],
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "session/setIsPruned",
        payload: false,
      },
      {
        type: "session/setContextPercentage",
        payload: 0.8,
      },
      {
        type: "session/setContextUsage",
        payload: {
          inputTokens: 26_214,
          contextLength: 32_768,
          availableTokens: undefined,
          model: "claude-3-5-sonnet-20241022",
          tokenBreakdown: undefined,
        },
      },
      {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant",
            content: "First chunk",
          },
          {
            role: "assistant",
            content: "Second chunk",
          },
        ],
      },
      {
        type: "session/addPromptCompletionPair",
        payload: [
          {
            prompt: "Hello",
            completion: "Hi there!",
            modelProvider: "anthropic",
            modelTitle: "Claude 3.5 Sonnet",
          },
        ],
      },
      {
        type: "session/setInactive",
        payload: undefined,
      },
      {
        type: "chat/streamNormalInput/fulfilled",
        meta: expect.objectContaining({
          arg: { legacySlashCommandData: undefined },
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "session/saveCurrent/pending",
        meta: expect.objectContaining({
          arg: { generateTitle: true, openNewSession: false },
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/update/pending",
        meta: expect.objectContaining({
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/updateSessionMetadata",
        payload: {
          sessionId: "session-123",
          title: "Session summary",
        },
      },
      {
        type: "session/refreshMetadata/pending",
        meta: expect.objectContaining({
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/setIsSessionMetadataLoading",
        payload: false,
      },
      {
        type: "session/setAllSessionMetadata",
        payload: [],
      },
      {
        type: "session/refreshMetadata/fulfilled",
        meta: expect.objectContaining({
          requestStatus: "fulfilled",
        }),
        payload: [],
      },
      {
        type: "session/update/fulfilled",
        meta: expect.objectContaining({
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "session/saveCurrent/fulfilled",
        meta: expect.objectContaining({
          arg: { generateTitle: true, openNewSession: false },
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "chat/streamWrapper/fulfilled",
        meta: expect.objectContaining({
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "chat/streamResponse/fulfilled",
        meta: expect.objectContaining({
          arg: { editorState: mockEditorState, modifiers: mockModifiers },
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
    ]);

    // Verify IDE messenger calls
    expect(requestSpy).toHaveBeenCalledWith("llm/compileChat", {
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello, please help me with this code",
            },
          ],
        },
      ],
      options: {},
    });

    expect(mockIdeMessenger.llmStreamChat).toHaveBeenCalledWith(
      {
        completionOptions: {},
        legacySlashCommandData: undefined,
        messageOptions: { precompiled: true },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
        title: "Claude 3.5 Sonnet",
      },
      expect.any(AbortSignal),
    );

    // Verify dev data logging call
    expect(postSpy).toHaveBeenCalledWith("devdata/log", {
      name: "chatInteraction",
      data: {
        prompt: "Hello",
        completion: "Hi there!",
        modelProvider: "anthropic",
        modelName: "Claude 3.5 Sonnet",
        modelTitle: "Claude 3.5 Sonnet",
        sessionId: "session-123",
      },
    });

    // Verify session save was called
    expect(requestSpy).toHaveBeenCalledWith("history/save", expect.anything());

    expect(result.type).toBe("chat/streamResponse/fulfilled");

    // Verify final state after thunk completion
    const finalState = mockStore.getState() as RootState;
    expect(finalState).toEqual({
      ...initialState,
      session: {
        ...initialState.session,
        chatModelTitle: "Claude 3.5 Sonnet",
        streamAborter: expect.any(AbortController),
        title: "Session summary",
        isPruned: false,
        inlineErrorMessage: undefined,
        contextPercentage: 0.8,
        contextUsage: {
          inputTokens: 26_214,
          contextLength: 32_768,
          availableTokens: undefined,
          model: "claude-3-5-sonnet-20241022",
        },
        history: [
          {
            contextItems: [],
            message: { id: "1", role: "user", content: "Hello" },
          },
          {
            appliedRules: [],
            contextItems: [],
            editorState: mockEditorState,
            message: {
              content: "Hello, please help me with this code",
              id: "mock-uuid-123",
              role: "user",
            },
          },
          {
            contextItems: [],
            isGatheringContext: false,
            message: {
              content: "First chunkSecond chunk", // Chunks get combined
              id: "mock-uuid-123",
              role: "assistant",
            },
            promptLogs: [
              {
                completion: "Hi there!",
                modelProvider: "anthropic",
                prompt: "Hello",
                modelTitle: "Claude 3.5 Sonnet",
              },
            ],
          },
        ],
      },
    });
  });

  it("sends simple greetings without native tool schemas in agent mode", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.id = "session-hello";
    initialState.session.history = [];
    initialState.session.mode = "agent";

    const grepTool = serializeTool(grepSearchTool);
    const grepName = grepTool.function.name;
    initialState.config.config.tools = [grepTool];
    initialState.config.config.rules = [
      {
        source: "rules-block",
        rule: "DO_NOT_SEND_THIS_RULE_FOR_SIMPLE_GREETING",
      },
    ];
    initialState.ui.toolSettings = {
      [grepName]: "allowedWithoutPermission",
    };

    mockResolveEditorContent.mockResolvedValue({
      selectedContextItems: [],
      selectedCode: [],
      content: "Hello",
      legacyCommandWithInput: undefined,
    });

    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;
    mockIdeMessenger.responses["llm/compileChat"] = {
      compiledChatMessages: [{ role: "user", content: "Hello" }],
      didPrune: false,
      contextPercentage: 0.01,
      inputTokens: 50,
      contextLength: 32_768,
      availableTokens: 31_718,
    };
    mockIdeMessenger.setChatResponseText(
      "Hello! What would you like me to work on?",
    );
    const requestSpy = vi.spyOn(mockIdeMessenger, "request");

    await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    const compileCall = requestSpy.mock.calls.find(
      ([messageType]) => messageType === "llm/compileChat",
    );
    expect(compileCall).toBeDefined();
    expect(compileCall?.[1]).toMatchObject({
      options: {},
    });
    const systemMessage = compileCall?.[1].messages.find(
      (message: ChatMessage) => message.role === "system",
    );
    expect(systemMessage?.content).toBe("You are a helpful assistant.");
    expect(String(systemMessage?.content)).not.toContain(
      "DO_NOT_SEND_THIS_RULE_FOR_SIMPLE_GREETING",
    );
    expect(mockGetBaseSystemMessage).toHaveBeenCalledWith(
      "lightweight-chat",
      expect.objectContaining({ title: "Claude 3.5 Sonnet" }),
      [],
    );
  });

  it("sends only discovery tool schemas for broad codebase review prompts", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.id = "session-review-codebase";
    initialState.session.history = [];
    initialState.session.mode = "agent";

    initialState.config.config.tools = [
      readFileTool,
      grepSearchTool,
      runTerminalCommandTool,
      computerUseTool,
      editFileTool,
    ].map(serializeTool);

    mockResolveEditorContent.mockResolvedValue({
      selectedContextItems: [],
      selectedCode: [],
      content: "review the codebase",
      legacyCommandWithInput: undefined,
    });

    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;
    mockIdeMessenger.responses["llm/compileChat"] = {
      compiledChatMessages: [{ role: "user", content: "review the codebase" }],
      didPrune: false,
      contextPercentage: 0.01,
      inputTokens: 500,
      contextLength: 32_768,
      availableTokens: 31_268,
    };
    mockIdeMessenger.setChatResponseText("Review complete.");
    const requestSpy = vi.spyOn(mockIdeMessenger, "request");

    await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    const compileCall = requestSpy.mock.calls.find(
      ([messageType]) => messageType === "llm/compileChat",
    );
    expect(compileCall).toBeDefined();
    const sentToolNames = compileCall?.[1].options.tools.map(
      (tool: { function: { name: string } }) => tool.function.name,
    );
    expect(sentToolNames).toEqual([
      BuiltInToolNames.ReadFile,
      BuiltInToolNames.GrepSearch,
    ]);
    expect(sentToolNames).not.toContain(BuiltInToolNames.RunTerminalCommand);
    expect(sentToolNames).not.toContain(BuiltInToolNames.ComputerUse);
    expect(sentToolNames).not.toContain(BuiltInToolNames.EditExistingFile);
  });

  it("sends skill and terminal tool schemas for explicit dollar skill prompts", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.id = "session-mosfs-skill";
    initialState.session.history = [];
    initialState.session.mode = "agent";

    initialState.config.config.tools = [
      readFileTool,
      grepSearchTool,
      runTerminalCommandTool,
      readSkillTestTool,
      computerUseTool,
      editFileTool,
    ].map(serializeTool);

    mockResolveEditorContent.mockResolvedValue({
      selectedContextItems: [],
      selectedCode: [],
      content: "use $mosfs review 4-0003351421 and find the RCA",
      legacyCommandWithInput: undefined,
    });

    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;
    mockIdeMessenger.responses["llm/compileChat"] = {
      compiledChatMessages: [
        {
          role: "user",
          content: "use $mosfs review 4-0003351421 and find the RCA",
        },
      ],
      didPrune: false,
      contextPercentage: 0.01,
      inputTokens: 500,
      contextLength: 32_768,
      availableTokens: 31_268,
    };
    mockIdeMessenger.setChatResponseText("MOSFS review complete.");
    const requestSpy = vi.spyOn(mockIdeMessenger, "request");

    await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    const compileCall = requestSpy.mock.calls.find(
      ([messageType]) => messageType === "llm/compileChat",
    );
    expect(compileCall).toBeDefined();
    const sentToolNames = compileCall?.[1].options.tools.map(
      (tool: { function: { name: string } }) => tool.function.name,
    );

    expect(sentToolNames).toContain(BuiltInToolNames.ReadSkill);
    expect(sentToolNames).toContain(BuiltInToolNames.RunTerminalCommand);
    expect(sentToolNames).toContain(BuiltInToolNames.ReadFile);
    expect(sentToolNames).toContain(BuiltInToolNames.GrepSearch);
    expect(sentToolNames).not.toContain(BuiltInToolNames.ComputerUse);
    expect(sentToolNames).not.toContain(BuiltInToolNames.EditExistingFile);
  });

  it("sends skill and terminal tool schemas for SR attachment follow-ups", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.id = "session-sr-attachments";
    initialState.session.history = [];
    initialState.session.mode = "agent";

    initialState.config.config.tools = [
      readFileTool,
      grepSearchTool,
      runTerminalCommandTool,
      readSkillTestTool,
      computerUseTool,
      editFileTool,
    ].map(serializeTool);

    mockResolveEditorContent.mockResolvedValue({
      selectedContextItems: [],
      selectedCode: [],
      content: "read the attachments provided by customer",
      legacyCommandWithInput: undefined,
    });

    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;
    mockIdeMessenger.responses["llm/compileChat"] = {
      compiledChatMessages: [
        {
          role: "user",
          content: "read the attachments provided by customer",
        },
      ],
      didPrune: false,
      contextPercentage: 0.01,
      inputTokens: 500,
      contextLength: 32_768,
      availableTokens: 31_268,
    };
    mockIdeMessenger.setChatResponseText("Attachments reviewed.");
    const requestSpy = vi.spyOn(mockIdeMessenger, "request");

    await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    const compileCall = requestSpy.mock.calls.find(
      ([messageType]) => messageType === "llm/compileChat",
    );
    expect(compileCall).toBeDefined();
    const sentToolNames = compileCall?.[1].options.tools.map(
      (tool: { function: { name: string } }) => tool.function.name,
    );

    expect(sentToolNames).toContain(BuiltInToolNames.ReadSkill);
    expect(sentToolNames).toContain(BuiltInToolNames.RunTerminalCommand);
    expect(sentToolNames).toContain(BuiltInToolNames.ReadFile);
    expect(sentToolNames).toContain(BuiltInToolNames.GrepSearch);
    expect(sentToolNames).not.toContain(BuiltInToolNames.ComputerUse);
    expect(sentToolNames).not.toContain(BuiltInToolNames.EditExistingFile);
  });

  it("should execute streaming flow with tool call execution", async () => {
    // Set up auto-approved tool setting for our test tool
    const stateWithToolSettings = getRootStateWithClaude();
    stateWithToolSettings.session.history = [
      {
        message: {
          id: "1",
          role: "user",
          content: "Please search the codebase",
        },
        contextItems: [],
      },
    ];
    const grepTool = serializeTool(grepSearchTool);
    const grepName = grepTool.function.name;
    stateWithToolSettings.config.config.tools = [grepTool];

    stateWithToolSettings.ui.toolSettings = {
      [grepName]: "allowedWithoutPermission", // Auto-approve this tool
    };
    stateWithToolSettings.session.id = "session-123";
    const mockStoreWithToolSettings = createMockStore(stateWithToolSettings);

    const mockIdeMessengerWithTool = mockStoreWithToolSettings.mockIdeMessenger;

    // Setup successful compilation and tool responses
    mockIdeMessengerWithTool.responses["llm/compileChat"] = {
      compiledChatMessages: [
        { role: "user", content: "Please search the codebase" },
      ],
      didPrune: false,
      contextPercentage: 0.9,
    };
    mockIdeMessengerWithTool.responses["tools/call"] = {
      contextItems: [
        {
          name: "Search Results",
          description: "Found 3 matches",
          content: "Result 1\nResult 2\nResult 3",
          icon: "search",
          hidden: false,
        },
      ],
      errorMessage: undefined,
    };
    const requestSpy = vi.spyOn(mockIdeMessengerWithTool, "request");

    // Setup streaming generator with tool call
    async function* mockStreamGeneratorWithTool(): AsyncGenerator<
      ChatMessage[],
      PromptLog
    > {
      yield [
        {
          role: "assistant",
          content: "I'll search the codebase for you.",
        },
      ];
      yield [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool-call-1",
              type: "function",
              function: {
                name: grepTool.function.name,
                arguments: JSON.stringify({ query: "test function" }),
              },
            },
          ],
        },
      ];
      return {
        prompt: "Please search the codebase",
        completion: "I'll search the codebase for you.",
        modelProvider: "anthropic",
        modelTitle: "Claude 3.5 Sonnet",
      };
    }

    // Mock different streaming responses for multiple calls
    let streamCallCount = 0;
    const mockStreamChat = vi.fn().mockImplementation(() => {
      streamCallCount++;
      if (streamCallCount === 1) {
        // First call - main streaming with tool call
        return mockStreamGeneratorWithTool();
      } else {
        // Subsequent calls from streamResponseAfterToolCall - return minimal response
        async function* simpleGenerator(): AsyncGenerator<
          AssistantChatMessage[],
          PromptLog
        > {
          yield [{ role: "assistant", content: "Search completed." }];
          return {
            prompt: "continuing after tool",
            completion: "Search completed.",
            modelProvider: "anthropic",
            modelTitle: "Claude 3.5 Sonnet",
          };
        }
        return simpleGenerator();
      }
    });
    mockIdeMessengerWithTool.llmStreamChat = mockStreamChat;

    // Execute thunk
    const result = await mockStoreWithToolSettings.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    // Verify key actions are dispatched (tool calls trigger a complex cascade, so we verify key actions exist)
    const dispatchedActions = mockStoreWithToolSettings.getActions();

    // Verify exact action sequence
    const actionTypes = dispatchedActions.map((action: any) => action.type);
    expect(actionTypes).toEqual([
      "chat/streamResponse/pending",
      "chat/streamWrapper/pending",
      "session/submitEditorAndInitAtIndex",
      "session/resetNextCodeBlockToApplyIndex",
      "session/setSessionChatModelTitle",
      "symbols/updateFromContextItems/pending",
      "session/updateHistoryItemAtIndex",
      "chat/streamNormalInput/pending",
      "session/setAppliedRulesAtIndex",
      "session/setActive",
      "session/setInlineErrorMessage",
      "symbols/updateFromContextItems/fulfilled",
      "session/setIsPruned",
      "session/setContextPercentage",
      "session/setContextUsage",
      "session/streamUpdate",
      "session/addPromptCompletionPair",
      "session/setToolGenerated",
      "chat/callTool/pending",
      "session/setActive",
      "session/setToolCallCalling",
      "session/updateToolCallOutput",
      "session/acceptToolCall",
      "chat/streamAfterToolCall/pending",
      "chat/streamWrapper/pending",
      "session/resetNextCodeBlockToApplyIndex",
      "session/streamUpdate",
      "chat/streamNormalInput/pending",
      "session/setAppliedRulesAtIndex",
      "session/setActive",
      "session/setInlineErrorMessage",
      "session/setIsPruned",
      "session/setContextPercentage",
      "session/setContextUsage",
      "session/streamUpdate",
      "session/addPromptCompletionPair",
      "session/setInactive",
      "chat/streamNormalInput/fulfilled",
      "session/saveCurrent/pending",
      "session/update/pending",
      "session/updateSessionMetadata",
      "session/refreshMetadata/pending",
      "session/setIsSessionMetadataLoading",
      "session/setAllSessionMetadata",
      "session/refreshMetadata/fulfilled",
      "session/update/fulfilled",
      "session/saveCurrent/fulfilled",
      "chat/streamWrapper/fulfilled",
      "chat/streamAfterToolCall/fulfilled",
      "chat/callTool/fulfilled",
      "chat/streamNormalInput/fulfilled",
      "session/saveCurrent/pending",
      "session/update/pending",
      "session/updateSessionMetadata",
      "session/refreshMetadata/pending",
      "session/setIsSessionMetadataLoading",
      "session/setAllSessionMetadata",
      "session/refreshMetadata/fulfilled",
      "session/update/fulfilled",
      "session/saveCurrent/fulfilled",
      "chat/streamWrapper/fulfilled",
      "chat/streamResponse/fulfilled",
    ]);

    // Verify key payload data for important actions
    const setContextPercentageAction = dispatchedActions.find(
      (a: any) => a.type === "session/setContextPercentage",
    );
    expect(setContextPercentageAction?.payload).toBe(0.9);

    const streamUpdates = dispatchedActions.filter(
      (a: any) => a.type === "session/streamUpdate",
    );
    expect(streamUpdates[0].payload).toEqual([
      { role: "assistant", content: "I'll search the codebase for you." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tool-call-1",
            type: "function",
            function: {
              name: grepName,
              arguments: JSON.stringify({ query: "test function" }),
            },
          },
        ],
      },
    ]);

    const completionPairs = dispatchedActions.filter(
      (a: any) => a.type === "session/addPromptCompletionPair",
    );
    expect(completionPairs[0].payload).toEqual([
      {
        completion: "I'll search the codebase for you.",
        modelProvider: "anthropic",
        modelTitle: "Claude 3.5 Sonnet",
        prompt: "Please search the codebase",
      },
    ]);

    const toolCallActions = dispatchedActions.filter(
      (a: any) => a.type === "session/setToolCallCalling",
    );
    expect(toolCallActions[0].payload).toEqual({ toolCallId: "tool-call-1" });

    const toolOutputActions = dispatchedActions.filter(
      (a: any) => a.type === "session/updateToolCallOutput",
    );
    expect(toolOutputActions[0].payload).toEqual({
      toolCallId: "tool-call-1",
      contextItems: [
        {
          name: "Search Results",
          description: "Found 3 matches",
          content: "Result 1\nResult 2\nResult 3",
          icon: "search",
          hidden: false,
        },
      ],
    });

    // Verify IDE messenger calls
    expect(requestSpy).toHaveBeenCalledWith("llm/compileChat", {
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Please search the codebase",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello, please help me with this code",
            },
          ],
        },
      ],
      options: { tools: [grepTool] },
    });

    expect(requestSpy).toHaveBeenCalledWith("tools/call", {
      toolCall: {
        id: "tool-call-1",
        type: "function",
        function: {
          name: grepName,
          arguments: JSON.stringify({ query: "test function" }),
        },
      },
    });

    // Verify that multiple compilation calls were made (due to tool call continuation)
    expect(requestSpy).toHaveBeenCalledWith(
      "llm/compileChat",
      expect.any(Object),
    );

    expect(result.type).toBe("chat/streamResponse/fulfilled");

    // Verify final state after tool call execution
    const finalState = mockStoreWithToolSettings.getState();
    expect(finalState).toEqual({
      ...stateWithToolSettings,
      session: {
        ...stateWithToolSettings.session,
        chatModelTitle: "Claude 3.5 Sonnet",
        history: [
          {
            contextItems: [],
            message: {
              id: "1",
              role: "user",
              content: "Please search the codebase",
            },
          },
          {
            appliedRules: [],
            contextItems: [],
            editorState: mockEditorState,
            message: {
              id: expect.any(String),
              role: "user",
              content: "Hello, please help me with this code",
            },
          },
          {
            contextItems: [],
            message: {
              content: "I'll search the codebase for you.",
              id: expect.any(String),
              role: "assistant",
              toolCalls: [
                {
                  id: "tool-call-1",
                  type: "function",
                  function: {
                    name: grepName,
                    arguments: JSON.stringify({ query: "test function" }),
                  },
                },
              ],
            },
            promptLogs: [
              {
                completion: "I'll search the codebase for you.",
                modelProvider: "anthropic",
                modelTitle: "Claude 3.5 Sonnet",
                prompt: "Please search the codebase",
              },
            ],
            toolCallStates: [
              {
                toolCallId: "tool-call-1",
                toolCall: {
                  id: "tool-call-1",
                  type: "function",
                  function: {
                    name: grepName,
                    arguments: JSON.stringify({ query: "test function" }),
                  },
                },
                parsedArgs: { query: "test function" },
                status: "done",
                mcpUiState: undefined,
                output: [
                  {
                    name: "Search Results",
                    description: "Found 3 matches",
                    content: "Result 1\nResult 2\nResult 3",
                    icon: "search",
                    hidden: false,
                  },
                ],
                tool: grepTool,
              },
            ],
          },
          {
            contextItems: [],
            message: {
              content: "Result 1\nResult 2\nResult 3",
              id: expect.any(String),
              role: "tool",
              toolCallId: "tool-call-1",
            },
          },
          {
            contextItems: [],
            isGatheringContext: false,
            message: {
              content: "Search completed.",
              id: "mock-uuid-123",
              role: "assistant",
            },
            promptLogs: [
              {
                completion: "Search completed.",
                modelProvider: "anthropic",
                modelTitle: "Claude 3.5 Sonnet",
                prompt: "continuing after tool",
              },
            ],
          },
        ],
        title: "Session summary",
        id: "session-123",
        streamAborter: expect.any(AbortController),
        contextPercentage: 0.9,
        contextUsage: {
          inputTokens: 29_491,
          contextLength: 32_768,
          availableTokens: undefined,
          model: "claude-3-5-sonnet-20241022",
        },
        isPruned: false,
        inlineErrorMessage: undefined,
      },
    });
  });

  it("should handle streaming abort", async () => {
    // Create an AbortController that we'll abort during streaming
    const testAbortController = new AbortController();

    // Create store with our test abort controller, starting from setupTest config
    const abortState = getRootStateWithClaude();
    abortState.session.streamAborter = testAbortController;
    abortState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    abortState.session.id = "session-123";
    const mockStoreWithAbort = createMockStore(abortState);
    const mockIdeMessengerAbort = mockStoreWithAbort.mockIdeMessenger;
    mockIdeMessengerAbort.responses["llm/compileChat"] = {
      compiledChatMessages: [{ role: "user", content: "Hello" }],
      didPrune: false,
      contextPercentage: 0.8,
    };
    const requestSpy = vi.spyOn(mockIdeMessengerAbort, "request");
    const postSpy = vi.spyOn(mockIdeMessengerAbort, "post");

    // Setup streaming generator that simulates abort by user interaction
    async function* mockStreamGeneratorWithAbort(): AsyncGenerator<
      AssistantChatMessage[],
      PromptLog
    > {
      yield [{ role: "assistant", content: "First chunk" }];

      // Add a delay to allow the first chunk to be processed
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Simulate user clicking abort button - dispatch setInactive immediately
      mockStoreWithAbort.dispatch({ type: "session/setInactive" });

      // Add a small delay to let the abort action be processed
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Try to yield second chunk (should be ignored due to abort)
      yield [{ role: "assistant", content: "Second chunk" }];

      return {
        prompt: "Hello",
        completion: "Complete response",
        modelProvider: "anthropic",
        modelTitle: "claude",
      };
    }

    const mockStreamChat = vi
      .fn()
      .mockReturnValue(mockStreamGeneratorWithAbort());
    mockIdeMessengerAbort.llmStreamChat = mockStreamChat;

    // Execute thunk - should be aborted
    const result = await mockStoreWithAbort.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    // Verify thunk completed successfully (abort just stops streaming early)
    expect(result.type).toBe("chat/streamResponse/fulfilled");

    // Verify exact action sequence - should start but then be aborted
    const dispatchedActions = mockStoreWithAbort.getActions();
    expect(dispatchedActions).toEqual([
      {
        type: "chat/streamResponse/pending",
        meta: {
          arg: {
            editorState: mockEditorState,
            modifiers: mockModifiers,
          },
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "chat/streamWrapper/pending",
        meta: {
          arg: expect.any(Function),
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/submitEditorAndInitAtIndex",
        payload: {
          editorState: mockEditorState,
          index: 1,
        },
      },
      {
        type: "session/resetNextCodeBlockToApplyIndex",
        payload: undefined,
      },
      {
        type: "session/setSessionChatModelTitle",
        payload: "Claude 3.5 Sonnet",
      },
      {
        type: "symbols/updateFromContextItems/pending",
        meta: {
          arg: [],
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/updateHistoryItemAtIndex",
        payload: {
          index: 1,
          updates: {
            contextItems: [],
            message: {
              content: "Hello, please help me with this code",
              id: "mock-uuid-123",
              role: "user",
            },
          },
        },
      },
      {
        type: "chat/streamNormalInput/pending",
        meta: {
          arg: {
            legacySlashCommandData: undefined,
          },
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/setAppliedRulesAtIndex",
        payload: {
          appliedRules: [],
          index: 1,
        },
      },
      {
        type: "session/setActive",
        payload: undefined,
      },
      {
        type: "session/setInlineErrorMessage",
        payload: undefined,
      },
      {
        type: "symbols/updateFromContextItems/fulfilled",
        meta: {
          arg: [],
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "session/setIsPruned",
        payload: false,
      },
      {
        type: "session/setContextPercentage",
        payload: 0.8,
      },
      {
        type: "session/setContextUsage",
        payload: {
          inputTokens: 26_214,
          contextLength: 32_768,
          availableTokens: undefined,
          model: "claude-3-5-sonnet-20241022",
          tokenBreakdown: undefined,
        },
      },
      // User abort action (dispatched by the test)
      {
        type: "session/setInactive",
      },
      {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant",
            content: "First chunk",
          },
        ],
      },
      // Stream abort dispatch (called by implementation)
      {
        type: "session/abortStream",
        payload: undefined,
      },
      {
        type: "chat/streamNormalInput/fulfilled",
        meta: {
          arg: {
            legacySlashCommandData: undefined,
          },
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "session/saveCurrent/pending",
        meta: {
          arg: {
            generateTitle: true,
            openNewSession: false,
          },
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/update/pending",
        meta: {
          arg: expect.objectContaining({
            history: expect.any(Array),
            sessionId: "session-123",
            title: "Session summary",
            workspaceDirectory: "",
          }),
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/updateSessionMetadata",
        payload: {
          sessionId: "session-123",
          title: "Session summary",
        },
      },
      {
        type: "session/refreshMetadata/pending",
        meta: {
          arg: {},
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/setIsSessionMetadataLoading",
        payload: false,
      },
      {
        type: "session/setAllSessionMetadata",
        payload: [],
      },
      {
        type: "session/refreshMetadata/fulfilled",
        meta: {
          arg: {},
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: [],
      },
      {
        type: "session/update/fulfilled",
        meta: {
          arg: expect.objectContaining({
            history: expect.any(Array),
            sessionId: "session-123",
            title: "Session summary",
            workspaceDirectory: "",
          }),
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "session/saveCurrent/fulfilled",
        meta: {
          arg: {
            generateTitle: true,
            openNewSession: false,
          },
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "chat/streamWrapper/fulfilled",
        meta: {
          arg: expect.any(Function),
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "chat/streamResponse/fulfilled",
        meta: {
          arg: {
            editorState: mockEditorState,
            modifiers: mockModifiers,
          },
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
    ]);

    // Verify IDE messenger calls
    expect(requestSpy).toHaveBeenCalledWith("llm/compileChat", {
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello, please help me with this code",
            },
          ],
        },
      ],
      options: {},
    });

    expect(mockIdeMessengerAbort.llmStreamChat).toHaveBeenCalledWith(
      {
        completionOptions: {},
        legacySlashCommandData: undefined,
        messageOptions: { precompiled: true },
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
        title: "Claude 3.5 Sonnet",
      },
      expect.any(AbortSignal),
    );

    // Dev data logging should not occur since streaming was stopped early
    expect(postSpy).not.toHaveBeenCalledWith("devdata/log", expect.anything());

    // Verify session save was called despite abort
    expect(requestSpy).toHaveBeenCalledWith("history/save", expect.anything());

    // Verify final state - streaming should be stopped, partial content preserved
    const finalState = mockStoreWithAbort.getState();
    expect(finalState).toEqual({
      ...abortState,
      session: {
        ...abortState.session,
        chatModelTitle: "Claude 3.5 Sonnet",
        history: [
          {
            contextItems: [],
            message: { id: "1", role: "user", content: "Hello" },
          },
          {
            appliedRules: [],
            contextItems: [],
            editorState: mockEditorState,
            message: {
              content: "Hello, please help me with this code",
              id: "mock-uuid-123",
              role: "user",
            },
          },
          {
            contextItems: [],
            isGatheringContext: false,
            message: {
              content: "First chunk", // Only first chunk before abort
              id: "mock-uuid-123",
              role: "assistant",
            },
            // No promptLogs because streaming was stopped before completion
          },
        ],
        id: "session-123",
        streamAborter: expect.any(AbortController), // New controller after abort
        contextPercentage: 0.8,
        contextUsage: {
          inputTokens: 26_214,
          contextLength: 32_768,
          availableTokens: undefined,
          model: "claude-3-5-sonnet-20241022",
        },
        inlineErrorMessage: undefined,
        isPruned: false,
        title: "Session summary",
      },
    });
  });

  it("auto-compacts and retries the same turn when compiled context is too large", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Earlier question" },
        contextItems: [],
      },
      {
        message: {
          id: "2",
          role: "assistant",
          content: "Earlier answer that can be summarized",
        },
        contextItems: [],
      },
      {
        message: { id: "3", role: "user", content: "Follow-up question" },
        contextItems: [],
      },
      {
        message: {
          id: "4",
          role: "assistant",
          content: "Follow-up answer",
        },
        contextItems: [],
      },
    ];
    initialState.session.id = "session-123";

    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;
    const originalRequest = mockIdeMessenger.request.bind(mockIdeMessenger);
    const compileRequests: any[] = [];
    const compactRequests: any[] = [];

    vi.spyOn(mockIdeMessenger, "request").mockImplementation(
      async (message, data) => {
        if (message === "llm/compileChat") {
          compileRequests.push(data);
          if (compileRequests.length === 1) {
            return {
              done: true,
              status: "success",
              content: {
                compiledChatMessages: [
                  { role: "user", content: "compiled before compaction" },
                ],
                didPrune: true,
                contextPercentage: 0.95,
              },
            } as any;
          }
          return {
            done: true,
            status: "success",
            content: {
              compiledChatMessages: [
                { role: "user", content: "compiled after compaction" },
              ],
              didPrune: false,
              contextPercentage: 0.4,
            },
          } as any;
        }
        if (message === "conversation/compact") {
          compactRequests.push(data);
          return {
            done: true,
            status: "success",
            content: "Summary of earlier conversation",
          } as any;
        }
        return originalRequest(message as any, data as any);
      },
    );

    async function* compactedStream(): AsyncGenerator<
      AssistantChatMessage[],
      PromptLog
    > {
      yield [{ role: "assistant", content: "Continued after compaction" }];
      return {
        prompt: "compiled after compaction",
        completion: "Continued after compaction",
        modelProvider: "anthropic",
        modelTitle: "Claude 3.5 Sonnet",
      };
    }

    const streamSpy = vi.fn().mockImplementation(() => compactedStream());
    mockIdeMessenger.llmStreamChat = streamSpy;

    const result = await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    expect(result.type).toBe("chat/streamResponse/fulfilled");
    expect(compileRequests).toHaveLength(2);
    expect(compactRequests).toEqual([
      { index: 3, sessionId: "session-123", automatic: true },
    ]);
    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "compiled after compaction" }],
      }),
      expect.any(AbortSignal),
    );

    const finalState = mockStore.getState() as RootState;
    expect(finalState.session.inlineErrorMessage).toBeUndefined();
    expect(finalState.session.contextPercentage).toBe(0.4);
    expect(finalState.session.history[3].conversationSummary).toBe(
      "Summary of earlier conversation",
    );
    expect(finalState.session.history[3].conversationSummaryAutomatic).toBe(
      true,
    );
  });

  it("auto-compacts and retries instead of stopping on a not-enough-context compile error", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Earlier question" },
        contextItems: [],
      },
      {
        message: {
          id: "2",
          role: "assistant",
          content: "Earlier answer that can be summarized",
        },
        contextItems: [],
      },
      {
        message: { id: "3", role: "user", content: "Follow-up question" },
        contextItems: [],
      },
      {
        message: {
          id: "4",
          role: "assistant",
          content: "Follow-up answer",
        },
        contextItems: [],
      },
    ];
    initialState.session.id = "session-123";

    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;
    const originalRequest = mockIdeMessenger.request.bind(mockIdeMessenger);
    const compileRequests: any[] = [];
    const compactRequests: any[] = [];

    vi.spyOn(mockIdeMessenger, "request").mockImplementation(
      async (message, data) => {
        if (message === "llm/compileChat") {
          compileRequests.push(data);
          if (compileRequests.length === 1) {
            return {
              done: true,
              status: "error",
              error: "Not enough context available for this request",
            } as any;
          }
          return {
            done: true,
            status: "success",
            content: {
              compiledChatMessages: [
                { role: "user", content: "compiled after error compaction" },
              ],
              didPrune: false,
              contextPercentage: 0.35,
            },
          } as any;
        }
        if (message === "conversation/compact") {
          compactRequests.push(data);
          return {
            done: true,
            status: "success",
            content: "Summary after compile error",
          } as any;
        }
        return originalRequest(message as any, data as any);
      },
    );

    async function* recoveredStream(): AsyncGenerator<
      AssistantChatMessage[],
      PromptLog
    > {
      yield [{ role: "assistant", content: "Recovered with compaction" }];
      return {
        prompt: "compiled after error compaction",
        completion: "Recovered with compaction",
        modelProvider: "anthropic",
        modelTitle: "Claude 3.5 Sonnet",
      };
    }

    const streamSpy = vi.fn().mockImplementation(() => recoveredStream());
    mockIdeMessenger.llmStreamChat = streamSpy;

    const result = await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    expect(result.type).toBe("chat/streamResponse/fulfilled");
    expect(compileRequests).toHaveLength(2);
    expect(compactRequests).toEqual([
      { index: 3, sessionId: "session-123", automatic: true },
    ]);
    expect(streamSpy).toHaveBeenCalledTimes(1);
    const finalState = mockStore.getState() as RootState;
    expect(finalState.session.inlineErrorMessage).toBeUndefined();
    expect(finalState.session.history[3].conversationSummary).toBe(
      "Summary after compile error",
    );
  });
});
