export type SupportedLocale = "zh-CN" | "en-US";

export interface LocalizedCatalog<Key extends string = string> {
  readonly locale: SupportedLocale;
  readonly messages: Readonly<Record<Key, string>>;
}
