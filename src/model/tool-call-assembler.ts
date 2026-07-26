import { AgentError } from "../agent/errors.js";
import type { ToolCall } from "../agent/types.js";
import type { ModelStreamEvent } from "./types.js";

interface MutableToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

// ToolCallAssembler 把 OpenAI 流中分散到多个 chunk 的名称和参数拼成完整调用。
export class ToolCallAssembler {
  private readonly calls = new Map<number, MutableToolCall>();

  public accept(event: Extract<ModelStreamEvent, { type: "tool-call.delta" }>): void {
    const current = this.calls.get(event.index) ?? {
      id: "",
      name: "",
      argumentsText: "",
    };

    if (event.id !== undefined) {
      if (current.id !== "" && current.id !== event.id) {
        throw new AgentError("MODEL_PROTOCOL_ERROR", `同一 ToolCall index 返回了不同 ID：${event.index}`);
      }
      current.id = event.id;
    }

    if (event.name !== undefined) {
      current.name += event.name;
    }
    if (event.argumentsDelta !== undefined) {
      current.argumentsText += event.argumentsDelta;
    }

    this.calls.set(event.index, current);
  }

  public build(): readonly ToolCall[] {
    return [...this.calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => {
        if (call.id.trim() === "" || call.name.trim() === "") {
          throw new AgentError("MODEL_PROTOCOL_ERROR", `ToolCall ${index} 缺少 ID 或名称`);
        }

        let parsedArguments: unknown;
        try {
          parsedArguments = JSON.parse(call.argumentsText === "" ? "{}" : call.argumentsText);
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : "未知 JSON 错误";
          throw new AgentError(
            "MODEL_PROTOCOL_ERROR",
            `ToolCall ${call.name} 参数不是有效 JSON：${reason}`,
          );
        }

        return {
          id: call.id,
          name: call.name,
          arguments: parsedArguments,
        };
      });
  }
}
