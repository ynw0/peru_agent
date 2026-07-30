import type { TuiCommandDescriptor } from "./commands.js";

export interface TuiSuggestion { readonly kind: "command" | "file"; readonly value: string; readonly description?: string; }

export function getTuiSuggestions(input: string, commands: readonly TuiCommandDescriptor[], files: readonly string[]): readonly TuiSuggestion[] {
  const token = input.trimStart();
  if (token.startsWith("/")) return commands.filter(command => `/${command.name}`.startsWith(token.toLocaleLowerCase())).slice(0, 12).map(command => ({ kind: "command", value: `/${command.name}`, description: command.description }));
  const match = /(?:^|\s)@([^\s]*)$/.exec(input);
  if (match !== null) return files.filter(file => file.toLocaleLowerCase().includes((match[1] ?? "").toLocaleLowerCase())).slice(0, 20).map(file => ({ kind: "file", value: `@${file}` }));
  return [];
}

export function acceptTuiSuggestion(input: string, suggestion: TuiSuggestion): string {
  if (suggestion.kind === "command") return `${suggestion.value} `;
  return input.replace(/@[^\s]*$/, `${suggestion.value} `);
}
