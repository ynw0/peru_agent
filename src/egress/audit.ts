import type { EgressAuditEntry, EgressAuditStore } from "./types.js";

export class InMemoryEgressAuditStore implements EgressAuditStore {
  private readonly entries: EgressAuditEntry[] = [];

  public append(entry: EgressAuditEntry): void {
    this.entries.push(structuredClone(entry));
  }

  public list(): readonly EgressAuditEntry[] {
    return structuredClone(this.entries);
  }
}
