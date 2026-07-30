import type { GateReport } from "../subagent/types.js";

export class GateReportStore {
  private readonly reports = new Map<string, GateReport>();

  public submit(sessionId: string, report: GateReport): GateReport {
    if (report.summary.trim() === "") throw new Error("GateReport summary 不能为空");
    if (report.verdict !== "approved" && report.verdict !== "rejected") throw new Error("GateReport verdict 无效");
    if (this.reports.has(sessionId)) throw new Error("当前 Gate Attempt 已提交 GateReport");
    const copy = structuredClone(report);
    this.reports.set(sessionId, copy);
    return structuredClone(copy);
  }

  public get(sessionId: string): GateReport | undefined {
    const report = this.reports.get(sessionId);
    return report === undefined ? undefined : structuredClone(report);
  }

  public clear(sessionId: string): void { this.reports.delete(sessionId); }
}
