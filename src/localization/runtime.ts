import { validateLocalizationCatalogs } from "./catalog.js";
import type { SupportedLocale } from "./types.js";

export interface LocaleStore {
  load(): Promise<SupportedLocale | undefined>;
  save(locale: SupportedLocale): Promise<void>;
}

export class InMemoryLocaleStore implements LocaleStore {
  public constructor(private locale?: SupportedLocale) {}
  public async load(): Promise<SupportedLocale | undefined> { return this.locale; }
  public async save(locale: SupportedLocale): Promise<void> { this.locale = locale; }
}

export class LocalizationRuntime {
  private locale: SupportedLocale;

  public constructor(
    private readonly store: LocaleStore,
    defaultLocale: SupportedLocale = "zh-CN",
  ) {
    validateLocalizationCatalogs();
    this.locale = defaultLocale;
  }

  public async initialize(): Promise<SupportedLocale> {
    const stored = await this.store.load();
    if (stored !== undefined) this.locale = stored;
    return this.locale;
  }

  public getLocale(): SupportedLocale { return this.locale; }

  public async setLocale(locale: SupportedLocale): Promise<SupportedLocale> {
    if (locale !== "zh-CN" && locale !== "en-US") throw new Error(`不支持的语言：${String(locale)}`);
    await this.store.save(locale);
    this.locale = locale;
    return locale;
  }
}
