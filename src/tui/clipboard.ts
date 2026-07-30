const MAX_CLIPBOARD_BYTES = 256 * 1024;

export interface TuiClipboardWriter {
  copy(text: string): Promise<void>;
}

/** Windows Terminal and compatible terminals consume OSC52 as UTF-8 text. */
export class Osc52ClipboardWriter implements TuiClipboardWriter {
  public constructor(
    private readonly output: { write(value: string): unknown } = process.stdout,
    private readonly maximumBytes = MAX_CLIPBOARD_BYTES,
  ) {}

  public async copy(text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > this.maximumBytes) {
      throw new Error(`复制内容超过 ${this.maximumBytes} 字节限制`);
    }
    const encoded = Buffer.from(bytes).toString("base64");
    this.output.write(`\u001b]52;c;${encoded}\u0007`);
  }
}

export function createRecordingClipboardWriter(): TuiClipboardWriter & { readonly values: readonly string[] } {
  const values: string[] = [];
  return {
    values,
    copy: async text => { values.push(text); },
  };
}
