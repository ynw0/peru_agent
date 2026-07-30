import type { AgentEvent } from "../agent-protocol.js";
import type { ModelProvider, AssembledModelResponse } from "../model/types.js";
import { ToolCallAssembler } from "../model/tool-call-assembler.js";
import type { SessionStore } from "../storage/session-store.js";
import type { ToolExecutionContext } from "../tool-runtime.js";
import { ToolRegistry } from "../tool-runtime.js";
import { AgentError } from "./errors.js";
import type { EventJournal } from "./event-journal.js";
import type { IdGenerator } from "./id-generator.js";
import { PermissionCoordinator, type AgentEventEmitter } from "./permission-coordinator.js";
import type { AgentSession } from "./session.js";
import type { AgentRunLimits, AgentRunOptions, AgentSessionSnapshot, AgentUserInput, ToolAgentMessage } from "./types.js";

export interface AgentLoopOptions {
  readonly systemPrompt: string;
  readonly maxOutputTokensPerTurn: number;
  readonly limits: AgentRunLimits;
  readonly contextWindowTokens?: number;
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
  private readonly failedCompactions = new Set<string>();
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
    userInput: string | AgentUserInput,
    signal: AbortSignal,
    runOptions: AgentRunOptions = {},
  ): Promise<AgentSessionSnapshot> {
    const emit = this.createEmitter(session);
    const limits = runOptions.limits ?? this.options.limits;
    validateLimits(limits);

    try {
      const normalizedInput: AgentUserInput = typeof userInput === "string" ? { content: userInput } : userInput;
      if (normalizedInput.content.trim() === "") {
        throw new AgentError("INTERNAL_ERROR", "用户输入不能为空");
      }

      const userMessageId = this.dependencies.idGenerator.next("message");
      const shouldAssignTitle = session.snapshot().title === undefined && session.getMessages().length === 0;
      session.appendMessage({
        id: userMessageId,
        role: "user",
        content: normalizedInput.content,
        ...(normalizedInput.displayContent === undefined ? {} : { displayContent: normalizedInput.displayContent }),
        ...(normalizedInput.attachments === undefined ? {} : { attachments: normalizedInput.attachments.map(item => ({ ...item })) }),
      });
      if (shouldAssignTitle) {
        const titleSource = (normalizedInput.displayContent ?? normalizedInput.content).trim();
        const title = Array.from(titleSource).slice(0, 10).join("");
        if (title !== "") session.rename(title);
      }
      await this.persist(session);
      if (shouldAssignTitle && session.snapshot().title !== undefined) {
        await emit({
          type: "session.renamed",
          sessionId: session.id,
          title: session.snapshot().title ?? "",
        });
      }
      await emit({
        type: "user.message.added",
        sessionId: session.id,
        messageId: userMessageId,
        content: normalizedInput.content,
      });

      let toolCallCount = 0;
      let runTokenCount = 0;
      for (let turn = 1; turn <= limits.maxTurns; turn += 1) {
        this.assertNotAborted(signal);
        if (runTokenCount > limits.maxTotalTokens) {
          throw new AgentError(
            "TOKEN_BUDGET_EXCEEDED",
            `本次运行 Token 用量 ${runTokenCount} 超过限制 ${limits.maxTotalTokens}`,
          );
        }
        await emit({ type: "model.started", sessionId: session.id, turn });

        // 在开始接收 delta 前固定 messageId，UI 才能把流式文本投影到正确消息。
        const assistantMessageId = this.dependencies.idGenerator.next("message");
        await emit({
          type: "assistant.started",
          sessionId: session.id,
          messageId: assistantMessageId,
          turn,
        });
        const response = await this.collectModelResponse(
          session,
          assistantMessageId,
          emit,
          signal,
          runOptions,
        );
        session.addUsage(response.usage.inputTokens, response.usage.outputTokens);
        runTokenCount += response.usage.inputTokens + response.usage.outputTokens;
        await emit({
          type: "session.usage.updated",
          sessionId: session.id,
          inputTokens: session.snapshot().usage.inputTokens,
          outputTokens: session.snapshot().usage.outputTokens,
        });
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
          const guide = session.takeQueuedInput("guide");
          if (guide !== undefined) {
            await emit({ type: "session.input.dequeued", sessionId: session.id, queueId: guide.id });
            const guideMessageId = this.dependencies.idGenerator.next("message");
            session.appendMessage({ id: guideMessageId, role: "user", content: guide.input.content, ...(guide.input.displayContent === undefined ? {} : { displayContent: guide.input.displayContent }), ...(guide.input.attachments === undefined ? {} : { attachments: guide.input.attachments }) });
            await this.persist(session);
            await emit({ type: "user.message.added", sessionId: session.id, messageId: guideMessageId, content: guide.input.content });
            continue;
          }
          await this.compactIfNeeded(session, response.usage.inputTokens, signal, emit);
          session.complete();
          await this.persist(session);
          await emit({ type: "session.completed", sessionId: session.id });
          return session.snapshot();
        }

        if (response.toolCalls.length === 0) {
          throw new AgentError("MODEL_PROTOCOL_ERROR", "finish_reason=tool_calls 但没有 ToolCall");
        }

        toolCallCount += response.toolCalls.length;
        if (toolCallCount > limits.maxToolCalls) {
          throw new AgentError(
            "MAX_TOOL_CALLS_EXCEEDED",
            `ToolCall 数量 ${toolCallCount} 超过限制 ${limits.maxToolCalls}`,
          );
        }

        for (const toolCall of response.toolCalls) {
          this.assertNotAborted(signal);
          const toolResult = await this.executeTool(session, toolCall, emit, signal, runOptions);
          session.incrementToolCallCount();
          session.appendMessage(toolResult);
          await this.persist(session);
          const preview = createOutputPreview(toolResult.content);
          await emit({
            type: "tool.result",
            sessionId: session.id,
            toolName: toolResult.toolName,
            toolCallId: toolResult.toolCallId,
            outputPreview: preview.value,
            truncated: preview.truncated,
            isError: toolResult.isError,
          });
        }
        await this.compactIfNeeded(session, response.usage.inputTokens, signal, emit);
      }

      throw new AgentError(
        "MAX_TURNS_EXCEEDED",
        `Agent 达到最大轮次 ${limits.maxTurns}，未得到最终回答`,
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

  private async compactIfNeeded(
    session: AgentSession,
    inputTokens: number,
    signal: AbortSignal,
    emit: AgentEventEmitter,
  ): Promise<void> {
    const window = this.options.contextWindowTokens;
    if (window === undefined || window <= 0 || inputTokens < Math.ceil(window * 0.8)) return;
    const attemptKey = `${session.id}:${inputTokens}:${session.getMessages().length}`;
    if (this.failedCompactions.has(attemptKey)) return;
    const source = session.getMessages();
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let text = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    let finish: "stop" | "tool_calls" | undefined;
    try {
      for await (const event of this.dependencies.provider.stream({ systemPrompt: "请将以下会话压缩为结构化、忠实、可继续工作的摘要。", messages: source, tools: [], maxOutputTokens: 4096 }, controller.signal)) {
        if (event.type === "text.delta") text += event.delta;
        if (event.type === "response.completed") { finish = event.finishReason; usage = event.usage; }
      }
      if (finish !== "stop" || text.trim() === "") throw new AgentError("MODEL_PROTOCOL_ERROR", "自动压缩模型未返回有效摘要");
      session.compact(text.trim(), source.length);
      session.addUsage(usage.inputTokens, usage.outputTokens);
      session.setContextTokens(usage.outputTokens);
      await this.persist(session);
      await emit({ type: "session.compacted", sessionId: session.id, sourceMessageCount: source.length });
    } catch (error: unknown) {
      this.failedCompactions.add(attemptKey);
      await emit({ type: "session.compaction.failed", sessionId: session.id, code: error instanceof AgentError ? error.code : "INTERNAL_ERROR", message: error instanceof Error ? error.message : "自动压缩失败" });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private async collectModelResponse(
    session: AgentSession,
    assistantMessageId: string,
    emit: AgentEventEmitter,
    signal: AbortSignal,
    runOptions: AgentRunOptions,
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
      tools: this.dependencies.tools.listModelDefinitions(manifest =>
        this.isToolVisible(manifest, runOptions) && this.isToolAllowed(manifest.name, runOptions) && this.isManifestAllowed(manifest.capabilities, runOptions)),
      maxOutputTokens: this.options.maxOutputTokensPerTurn,
    }, signal)) {
      this.assertNotAborted(signal);
      if (completed !== undefined) {
        throw new AgentError("MODEL_PROTOCOL_ERROR", "response.completed 之后仍收到模型事件");
      }

      if (event.type === "text.delta") {
        text += event.delta;
        await emit({
          type: "assistant.delta",
          sessionId: session.id,
          messageId: assistantMessageId,
          delta: event.delta,
        });
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
    runOptions: AgentRunOptions,
  ): Promise<ToolAgentMessage> {
    const tool = this.dependencies.tools.get(toolCall.name);
    if (tool !== undefined && (!this.isToolVisible(tool.manifest, runOptions) || !this.isToolAllowed(tool.manifest.name, runOptions) || !this.isManifestAllowed(tool.manifest.capabilities, runOptions))) {
      await emit({
        type: "tool.completed",
        sessionId: session.id,
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        success: false,
      });
      return this.createToolError(toolCall, `子 Agent 运行策略拒绝 Tool：${toolCall.name}`);
    }

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
      toolCallId: toolCall.id,
      toolName: tool.manifest.name,
      description: tool.manifest.description ?? tool.manifest.name,
      riskLevel: tool.manifest.riskLevel,
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

    const inspectionContext = {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      toolCallId: toolCall.id,
      signal,
    };
    let inspectionCompleted = false;
    try {
      const inspection = await tool.inspect(input, inspectionContext);
      inspectionCompleted = true;
      const effectiveCapabilities = [
        ...tool.manifest.capabilities,
        ...(inspection.requestedCapabilities ?? []),
      ];
      if (!this.isManifestAllowed(effectiveCapabilities, runOptions)) {
        throw new Error(`子 Agent 运行策略拒绝动态能力：${effectiveCapabilities.join(", ")}`);
      }
      await emit({
        type: "tool.inspected",
        sessionId: session.id,
        toolCallId: toolCall.id,
        toolName: tool.manifest.name,
        riskLevel: tool.manifest.riskLevel,
        affectedFiles: [...inspection.affectedFiles],
        networkTargets: [...(inspection.networkTargets ?? [])],
        commands: [...(inspection.commands ?? [])],
        ...(inspection.commandText === undefined ? {} : { commandText: inspection.commandText }),
      });
      const permission = await this.dependencies.permissions.authorize(
        session,
        toolCall.id,
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
        toolCallId: toolCall.id,
        signal,
        ...(runOptions.workspaceWriteMode === undefined ? {} : { workspaceWriteMode: runOptions.workspaceWriteMode }),
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
    } finally {
      if (inspectionCompleted) {
        await tool.releaseInspection?.(input, inspectionContext);
      }
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

  private isManifestAllowed(
    capabilities: readonly import("../agent-protocol.js").Capability[],
    runOptions: AgentRunOptions,
  ): boolean {
    if (runOptions.allowedCapabilities === undefined) {
      return true;
    }
    const allowed = new Set(runOptions.allowedCapabilities);
    return capabilities.every(capability => allowed.has(capability));
  }

  private isToolAllowed(name: string, runOptions: AgentRunOptions): boolean {
    return runOptions.allowedToolNames === undefined || runOptions.allowedToolNames.includes(name);
  }

  private isToolVisible(manifest: import("../tool-runtime.js").ToolManifest, runOptions: AgentRunOptions): boolean {
    return manifest.visibility !== "subagent" || runOptions.allowedToolNames?.includes(manifest.name) === true;
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

function createOutputPreview(content: string): { readonly value: string; readonly truncated: boolean } {
  const maximumCharacters = 8 * 1024;
  if (content.length <= maximumCharacters) {
    return { value: content, truncated: false };
  }
  const half = Math.floor(maximumCharacters / 2);
  return {
    value: `${content.slice(0, half)}\n…（结果过长，中间内容已省略；查看会话可获取完整结果）…\n${content.slice(-half)}`,
    truncated: true,
  };
}
