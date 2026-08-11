import type { CliRenderer } from "@opentui/core";
import { writeClipboard } from "./clipboard.js";

/**
 * 复用 OpenCode 的 Selection.copy 语义：renderer 是 Selection 的唯一事实来源，
 * 复制后立即清除 Selection；不自行计算终端字符坐标。
 */
export async function copyRendererSelection(renderer: CliRenderer): Promise<boolean> {
  const selection = renderer.getSelection();
  if (selection === null) return false;
  const text = selection.getSelectedText();
  if (text === "") return false;
  const copy = writeClipboard(text);
  renderer.clearSelection();
  await copy;
  return true;
}
