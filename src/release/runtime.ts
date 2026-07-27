import type { LocalizationRuntime } from "../localization/runtime.js";
import type { SupportedLocale } from "../localization/types.js";
import { evaluateReleaseGates } from "./gates.js";
import type { AtomicReleaseManager } from "./update-manager.js";
import type { ReleaseAuditEntry, ReleaseGateResult, ReleaseRuntimeSnapshot, SignedReleaseManifest } from "./types.js";
import type { ReleaseTrustStore } from "./signing.js";

export interface ReleaseRuntimeOptions {
  readonly productVersion: string;
  readonly channel: "stable" | "preview";
  readonly actorId: string;
  readonly now?: () => string;
  readonly nextId: (prefix: string) => string;
}

export class ReleaseRuntime {
  private readonly audit: ReleaseAuditEntry[] = [];
  private gateResults: readonly ReleaseGateResult[] = [];
  private lastCheckedAt: string | undefined;
  private readonly now: () => string;

  public constructor(
    private readonly localization: LocalizationRuntime,
    private readonly manager: AtomicReleaseManager,
    private readonly trustStore: ReleaseTrustStore,
    private readonly options: ReleaseRuntimeOptions,
  ) { this.now = options.now ?? (() => new Date().toISOString()); }

  public async initialize(): Promise<ReleaseRuntimeSnapshot> {
    await this.localization.initialize();
    return this.getSnapshot();
  }

  public setGateResults(results: readonly ReleaseGateResult[]): void { this.gateResults = results.map(result => ({ ...result })); }

  public async getSnapshot(): Promise<ReleaseRuntimeSnapshot> {
    const state = await this.manager.getState();
    const gates = evaluateReleaseGates(this.gateResults);
    return {
      productVersion: this.options.productVersion,
      channel: this.options.channel,
      locale: this.localization.getLocale(),
      ...(state.currentVersion === undefined ? {} : { currentVersion: state.currentVersion }),
      ...(state.previousVersion === undefined ? {} : { previousVersion: state.previousVersion }),
      installedVersions: [...state.installedVersions],
      productionReady: gates.ready,
      blockers: gates.blockers,
      ...(this.lastCheckedAt === undefined ? {} : { lastCheckedAt: this.lastCheckedAt }),
    };
  }

  public async setLocale(locale: SupportedLocale): Promise<ReleaseRuntimeSnapshot> {
    await this.localization.setLocale(locale);
    this.record("locale-changed", undefined, `locale=${locale}`);
    return this.getSnapshot();
  }

  public verifyManifest(manifest: SignedReleaseManifest): { readonly valid: true; readonly version: string } {
    if (!this.trustStore.verify(manifest)) throw new Error("发布 Manifest 签名验证失败");
    this.lastCheckedAt = this.now();
    this.record("manifest-verified", manifest.version, `signer=${manifest.signerKeyId}`);
    return { valid: true, version: manifest.version };
  }

  public async installBundle(bundleRoot: string, manifest: SignedReleaseManifest): Promise<ReleaseRuntimeSnapshot> {
    this.verifyManifest(manifest);
    await this.manager.installBundle(bundleRoot, manifest);
    this.record("version-activated", manifest.version, "atomic-state-switch");
    return this.getSnapshot();
  }

  public async rollback(): Promise<ReleaseRuntimeSnapshot> {
    const state = await this.manager.rollback();
    this.record("rollback", state.currentVersion, `previous=${state.previousVersion ?? "none"}`);
    return this.getSnapshot();
  }

  public listAudit(): readonly ReleaseAuditEntry[] { return this.audit.map(entry => ({ ...entry })); }

  private record(action: ReleaseAuditEntry["action"], version: string | undefined, details: string): void {
    this.audit.push({
      id: this.options.nextId("release-audit"), action,
      ...(version === undefined ? {} : { version }), actor: this.options.actorId,
      timestamp: this.now(), details,
    });
  }
}
