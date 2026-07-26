import type { AgentEvent } from "../agent-protocol.js";
import type { ModelProvider, AssembledModelResponse } from "../model/types.js";
import { ToolCallAssembler } from "../model/tool-call-assembler.js";
import type { SessionStore } from "../storage/session-store.js";
import type { Tool, ToolExecutionContext } from "../tool-runtime.js";
import { ToolRegistry } from "../tool-runtime.js";
import { AgentError } from "./errors.js";
import type { EventJournal } from "./event-journal.js";
import type { IdGenerator } from "./id-generator.js";
import { PermissionCoordinator, type AgentEventEmitter } from "./permission-coordinator.js";
import type { AgentSession } from "./session.js";
import type { AgentRunLimits, AgentSessionSnapshot, ToolAgentMessage } from "./types.js";

export interface AgentLoopOptions {
  readonly systemPrompt: string;
  readonly maxOutputTokensPerTurn: number;
  readonly limits: AgentRunLimits;
}

export interface AgentLoopDependencies {
  readonly provider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly permissions: PermissionCoordinator;
  readonly journal: EventJournal;
  readonly sessions: SessionStore;
  readonly idGenerator: IdGenerator;
  readonly onEvent?: (event: AgentEvent) => void | Promise<void>;
}

// AgentLoop 只负责一次会话运行；并发、创建、停止和 IPC 由 AgentRuntime 负责。
export class AgentLoop {
  public constructor(
    private readonly dependencies: AgentLoopDependencies,
    private readonly options: AgentLoopOptions,
  ) {
    if (options.systemPrompt.trim() === "") {
      throw new Error("Agent System Prompt 不能为空");
    }
    if (!Number.isInteger(options.maxOutputTokensPerTurn) || options.maxOutputTokensPerTurn <= 0) {
      throw new Error("每轮最大输出 Token 必须是正整数");
    }
    validateLimits(options.limits);
  }

  public async run(
    session: AgentSession,
    userInput: string,
    signal: AbortSignal,
  ): Promise<AgentSessionSnapshot> {
    const emit = this.createEmitter(session);

    try {
      if (userInput.trim() === "") {
        throw new AgentError("INTERNAL_ERROR", "用户输入不能为空");
      }

      session.appendMessage({
        id: this.dependencies.idGenerator.next("message"),
        role: "user",
        content: userInput,
      });
      await this.persist(session);

      let toolCallCount = 0;
      for (let turn = 1; turn <= this.options.limits.maxTurns; turn += 1) {
        this.assertNotAborted(signal);
        await emit({ type: "model.started", sessionId: session.id, turn });

        const response = await this.collectModelResponse(session, turn, emit, signal);
        session.addUsage(response.usage.inputTokens, response.usage.outputTokens);
        if (session.getTotalTokens() > this.options.limits.maxTotalTokens) {
          throw new AgentError(
            "TOKEN_BUDGET_EXCEEDED",
            `会话 Token 用量 ${session.getTotalTokens()} 超过限制 ${this.options.limits.maxTotalTokens}`,
          );
        }

        const assistantMessageId = this.dependencies.idGenerator.next("message");
        session.appendMessage({
          id: assistantMessageId,
          role: "assistant",
          content: response.text,
          toolCalls: response.toolCalls,
        });
        await this.persist(session);
        await emit({
          type: "assistant.completed",
          sessionId: session.id,
          messageId: assistantMessageId,
        });

        if (response.finishReason === "stop") {
          if (response.toolCalls.length !== 0) {
            throw new AgentError("MODEL_PROTOCOL_ERROR", "finish_reason=stop 时不允许包含 ToolCall");
          }
          session.complete();
          await this.persist(session);
          await emit({ type: "session.completed", sessionId: session.id });
          return session.snapshot();
        }

        if (response.toolCalls.length === 0) {
          throw new AgentError("MODEL_PROTOCOL_ERROR", "finish_reason=tool_calls 但没有 ToolCall");
        }

        toolCallCount += response.toolCalls.length;
        if (toolCallCount > this.options.limits.maxToolCalls) {
          throw new AgentError(
            "MAX_TOOL_CALLS_EXCEEDED",
            `ToolCall 数量 ${toolCallCount} 超过限制 ${this.options.limits.maxToolCalls}`,
          );
        }

        for (const toolCall of response.toolCalls) {
          this.assertNotAborted(signal);
          const toolResult = await this.executeTool(session, toolCall, emit, signal);
          session.appendMessage(toolResult);
          await this.persist(session);
        }
      }

      throw new AgentError(
        "MAX_TURNS_EXCEEDED",
        `Agent 达到最大轮次 ${this.options.limits.maxTurns}，未得到最终回答`,
      );
    } catch (error: unknown) {
      if (signal.aborted || (error instanceof AgentError && error.code === "RUN_ABORTED")) {
        session.abort();
        await this.persist(session);
        await emit({ type: "session.aborted", sessionId: session.id });
        return session.snapshot();
      }

      const agentError = error instanceof AgentError
        ? error
        : new AgentError(
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : "未知 Agent 内部错误",
        );
      session.fail(agentError.code, agentError.message);
      await this.persist(session);
      await emit({
        type: "session.failed",
        sessionId: session.id,
        code: agentError.code,
        message: agentError.message,
      });
      return session.snapshot();
    }
  }

  private async collectModelResponse(
    session: AgentSession,
    _turn: number,
    emit: AgentEventEmitter,
    signal: AbortSignal,
  ): Promise<AssembledModelResponse> {
    const assembler = new ToolCallAssembler();
    let text = "";
    let completed: Extract<
      Awaited<ReturnType<ModelProvider["stream"]>> extends AsyncIterable<infer Event> ? Event : never,
      { type: "response.completed" }
    > | undefined;

    for await (const event of this.dependencies.provider.stream({
      systemPrompt: this.options.systemPrompt,
      messages: session.getMessages(),
      tools: this.dependencies.tools.listModelDefinitions(),
      maxOutputTokens: this.options.maxOutputTokensPerTurn,
    }, signal)) {
      this.assertNotAborted(signal);
      if (completed !== undefined) {
        throw new AgentError("MODEL_PROTOCOL_ERROR", "response.completed 之后仍收到模型事件");
      }

      if (event.type === "text.delta") {
        text += event.delta;
        await emit({ type: "assistant.delta", sessionId: session.id, delta: event.delta });
      } else if (event.type === "tool-call.delta") {
        assembler.accept(event);
      } else {
        completed = event;
      }
    }

    if (completed === undefined) {
      throw new AgentError("MODEL_PROTOCOL_ERROR", "模型流结束时缺少 response.completed");
    }

    return {
      text,
      toolCalls: assembler.build(),
      finishReason: completed.finishReason,
      usage: completed.usage,
    };
  }

  private async executeTool(
    session: AgentSession,
    toolCall: { readonly id: string; readonly name: string; readonly arguments: unknown },
    emit: AgentEventEmitter,
    signal: AbortSignal,
  ): Promise<ToolAgentMessage> {
    const tool = this.dependencies.tools.get(toolCall.name);
    if (tool === undefined) {
      await emit({
        type: "tool.completed",
        sessionId: session.id,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        success: false,
      });
      return this.createToolError(toolCall, `Tool 未注册：${toolCall.name}`);
    }

    await emit({
      type: "tool.requested",
      sessionId: session.id,
      toolName: tool.manifest.name,
      capabilities: [...tool.manifest.capabilities],
    });

    let input: unknown;
    try {
      input = tool.validate(toolCall.arguments);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "未知参数校验错误";
      await this.emitToolCompleted(session, toolCall, false, emit);
      return this.createToolError(toolCall, `Tool 参数无效：${reason}`);
    }

    try {
      const inspection = await tool.inspect(input);
      await emit({
        type: "tool.inspected",
        sessionId: session.id,
        toolName: tool.manifest.name,
        affectedFiles: [...inspection.affectedFiles],
      });
      const permission = await this.dependencies.permissions.authorize(
        session,
        tool.manifest,
        inspection,
        emit,
        signal,
      );
      await this.persist(session);
      if (permission === "deny") {
        await this.emitToolCompleted(session, toolCall, false, emit);
        return this.createToolError(toolCall, `权限拒绝：${tool.manifest.name}`);
      }

      await emit({
        type: "tool.started",
        sessionId: session.id,
        toolName: tool.manifest.name,
        toolCallId: toolCall.id,
      });

      const context: ToolExecutionContext = {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        signal,
        reportProgress: async message => {
          if (message.trim() === "") {
            throw new Error("Tool 进度消息不能为空");
          }
          await emit({
            type: "tool.progress",
            sessionId: session.id,
            toolName: tool.manifest.name,
            toolCallId: toolCall.id,
            message,
          });
        },
      };

      const output = await tool.execute(input, context);
      const content = tool.serializeOutput(output);
      await this.emitToolCompleted(session, toolCall, true, emit);
      return {
        id: this.dependencies.idGenerator.next("message"),
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content,
        isError: false,
      };
    } catch (error: unknown) {
      if (signal.aborted) {
        throw new AgentError("RUN_ABORTED", "Tool 执行期间运行被取消");
      }
      const reason = error instanceof Error ? error.message : "未知 Tool 执行错误";
      await this.emitToolCompleted(session, toolCall, false, emit);
      return this.createToolError(toolCall, `Tool 执行失败：${reason}`);
    }
  }

  private createToolError(
    toolCall: { readonly id: string; readonly name: string },
    message: string,
  ): ToolAgentMessage {
    return {
      id: this.dependencies.idGenerator.next("message"),
      role: "tool",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: JSON.stringify({ error: message }),
      isError: true,
    };
  }

  private async emitToolCompleted(
    session: AgentSession,
    toolCall: { readonly id: string; readonly name: string },
    success: boolean,
    emit: AgentEventEmitter,
  ): Promise<void> {
    await emit({
      type: "tool.completed",
      sessionId: session.id,
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      success,
    });
  }

  private createEmitter(session: AgentSession): AgentEventEmitter {
    return async event => {
      await this.dependencies.journal.append(event);
      await this.persist(session);
      await this.dependencies.onEvent?.(event);
    };
  }

  private async persist(session: AgentSession): Promise<void> {
    await this.dependencies.sessions.save(session.snapshot());
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new AgentError("RUN_ABORTED", "运行已取消");
    }
  }
}

function validateLimits(limits: AgentRunLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} 必须是正整数`);
    }
  }
}
