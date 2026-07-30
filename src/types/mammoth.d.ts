declare module "mammoth" {
  export function extractRawText(input: { readonly buffer: Uint8Array }): Promise<{ readonly value: string; readonly messages: readonly unknown[] }>;
}
