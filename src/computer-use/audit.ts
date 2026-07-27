import type { ComputerUseAuditEntry } from "./types.js";

export interface ComputerUseAuditStore {
  append(entry: ComputerUseAuditEntry): Promise<void> | void;
  list(): Promise<readonly ComputerUseAuditEntry[]> | readonly ComputerUseAuditEntry[];
}

export class InMemoryComputerUseAuditStore implements ComputerUseAuditStore {
  private readonly entries: ComputerUseAuditEntry[] = [];
  public append(entry: ComputerUseAuditEntry): void { this.entries.push(structuredClone(entry)); }
  public list(): readonly ComputerUseAuditEntry[] { return structuredClone(this.entries); }
}
