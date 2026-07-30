import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { ContextItem, McpUiState } from "core";
import { CLIENT_TOOLS_IMPLS } from "core/tools/builtIn";
import { QivrynError, QivrynErrorReason } from "core/util/errors";

import { callClientTool } from "../../util/clientTools/callClientTool";
import { withAsyncTimeout } from "../../util/asyncTimeout";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  acceptToolCall,
  errorToolCall,
  setActive,
  setInactive,
  setToolCallCalling,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import {
  createSessionScopedDispatch,
  findSessionIdForToolCall,
  getRootStateForSession,
} from "../sessionRuntime";
import { ThunkApiType } from "../store";
import { findToolCallById, logToolUsage } from "../util";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

const TOOL_CALL_TIMEOUT_MS = 10 * 60 * 1000;

export const callToolById = createAsyncThunk<
  void,
  {
    toolCallId: string;
    isAutoApproved?: boolean;
    depth?: number;
    continueAfterToolCall?: boolean;
    sessionId?: string;
  },
  ThunkApiType
>("chat/callTool", async (inputs, { dispatch, extra, getState }) => {
  const {
    toolCallId,
    isAutoApproved,
    depth = 0,
    continueAfterToolCall = true,
    sessionId: requestedSessionId,
  } = inputs;

  const sessionId =
    requestedSessionId ??
    findSessionIdForToolCall(getState(), toolCallId) ??
    getState().session.id;
  const getScopedState = () => getRootStateForSession(getState(), sessionId);
  const scopedDispatch = createSessionScopedDispatch(
    dispatch,
    sessionId,
    getState,
  );
  const state = getScopedState();
  const toolCallState = findToolCallById(state.session.history, toolCallId);
  if (!toolCallState) {
    console.warn(`Tool call with ID ${toolCallId} not found`);
    return;
  }

  if (toolCallState.status !== "generated") {
    return;
  }

  const selectedChatModel =
    state.config.config?.modelsByRole?.chat?.find(
      (model) => model.title === state.session.chatModelTitle,
    ) ?? selectSelectedChatModel(state);

  if (!selectedChatModel) {
    throw new Error("No model selected");
  }

  // An approved tool remains part of the owning turn while it executes.
  scopedDispatch(setActive());
  scopedDispatch(
    setToolCallCalling({
      toolCallId,
    }),
  );

  let output: ContextItem[] | undefined = undefined;
  let mcpUiState: McpUiState | undefined = undefined;
  let error: QivrynError | undefined = undefined;
  let streamResponse: boolean;

  // IMPORTANT:
  // Errors that occur while calling tool call implementations
  // Are caught and passed in output as context items
  // Errors that occur outside specifically calling the tool
  // Should not be caught here - should be handled as normal stream errors
  try {
    if (
      CLIENT_TOOLS_IMPLS.find(
        (toolName) => toolName === toolCallState.toolCall.function.name,
      )
    ) {
      // Tool is called on client side
      const {
        output: clientToolOutput,
        respondImmediately,
        error: clientToolError,
      } = await withAsyncTimeout(
        callClientTool(toolCallState, {
          dispatch: scopedDispatch,
          ideMessenger: extra.ideMessenger,
          getState: getScopedState,
          sessionId,
        }),
        TOOL_CALL_TIMEOUT_MS,
        `${toolCallState.toolCall.function.name} tool call`,
      );
      output = clientToolOutput;
      error = clientToolError;
      streamResponse = respondImmediately;
    } else {
      // Tool is called on core side
      const result = await withAsyncTimeout(
        extra.ideMessenger.request("tools/call", {
          toolCall: toolCallState.toolCall,
        }),
        TOOL_CALL_TIMEOUT_MS,
        `${toolCallState.toolCall.function.name} tool call`,
      );
      if (result.status === "error") {
        throw new Error(result.error);
      } else {
        output = result.content.contextItems;
        mcpUiState = result.content.mcpUiState;
        error = result.content.errorMessage
          ? new QivrynError(
              result.content.errorReason || QivrynErrorReason.Unspecified,
              result.content.errorMessage,
            )
          : undefined;
      }
      streamResponse = true;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    scopedDispatch(
      errorToolCall({
        toolCallId,
        output: [
          {
            icon: "problems",
            name: "Tool Call Error",
            description: "Tool Call Failed",
            content: `${toolCallState.toolCall.function.name} failed with the message: ${message}\n\nPlease try a smaller request or run the tool again.`,
            hidden: false,
          },
        ],
      }),
    );
    scopedDispatch(setInactive());
    return;
  }

  const toolWasCanceled =
    findToolCallById(getScopedState().session.history, toolCallId)?.status ===
    "canceled";
  if (toolWasCanceled) {
    return;
  }

  if (error) {
    scopedDispatch(
      updateToolCallOutput({
        toolCallId,
        contextItems: [
          {
            icon: "problems",
            name: "Tool Call Error",
            description: "Tool Call Failed",
            content: `${toolCallState.toolCall.function.name} failed with the message: ${error.message}\n\nPlease try something else or request further instructions.`,
            hidden: false,
          },
        ],
      }),
    );
  } else if (output?.length) {
    scopedDispatch(
      updateToolCallOutput({
        toolCallId,
        contextItems: output,
        mcpUiState,
      }),
    );
  }

  if (streamResponse) {
    if (error) {
      logToolUsage(toolCallState, false, false, extra.ideMessenger, output);
      scopedDispatch(
        errorToolCall({
          toolCallId,
        }),
      );
    } else {
      logToolUsage(toolCallState, true, true, extra.ideMessenger, output);
      scopedDispatch(
        acceptToolCall({
          toolCallId,
        }),
      );
    }

    // Send to the LLM to continue the conversation
    const wrapped = await dispatch(
      streamResponseAfterToolCall({
        ...(getState().session.id === sessionId ? {} : { sessionId }),
        toolCallId,
        depth: depth + 1,
        continueAfterToolCall,
      }),
    );
    unwrapResult(wrapped);
  } else {
    scopedDispatch(setInactive());
  }
});
