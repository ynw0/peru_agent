import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import React, { useState } from "react";
import { render, Text, useInput } from "ink";
import { TuiConfigurationEditor } from "../src/tui/setup.js";
import { createTuiInputBuffer, reduceTuiInput } from "../src/tui/input-buffer.js";
import { createTuiConfigurationEditor } from "../src/tui/view-state.js";
import type { TuiSetupDraft } from "../src/tui/config.js";
import { TuiInputRouter } from "../src/tui/input-router.js";

class MockStdin extends PassThrough {
  public isTTY = true;
  public setRawMode(_mode: boolean): this { return this; }
  public ref(): this { return this; }
  public unref(): this { return this; }
}

class MockStdout extends PassThrough {
  public isTTY = true;
  public columns = 100;
  public rows = 30;
  public getColorDepth(): number { return 1; }
  public hasColors(): boolean { return false; }
  public cursorTo(): boolean { return true; }
  public clearLine(): boolean { return true; }
  public clearScreenDown(): boolean { return true; }
}

async function flush(application: ReturnType<typeof render>): Promise<void> {
  void application;
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function send(stdin: MockStdin, application: ReturnType<typeof render>, value: string): Promise<void> {
  stdin.write(value);
  await flush(application);
}

function outputOf(stdout: MockStdout): string {
  return stdout.read()?.toString("utf8") ?? "";
}

const draft: TuiSetupDraft = {
  configPath: "C:\\temp\\config.json",
  baseUrl: "http://127.0.0.1:1234/v1",
  chatCompletionsPath: "/chat/completions",
  model: "google/gemma-4-e2b",
  apiKey: "test-key",
  contextWindowTokens: "131072",
  sandboxBrokerExecutablePath: "C:\\temp\\broker.exe",
  permissionMode: "default",
  networkMode: "offline",
};

test("Mock TTY decodes Ink arrows and edits the real configuration editor", async () => {
  const stdin = new MockStdin();
  const stdout = new MockStdout();
  const application = render(
    React.createElement(TuiConfigurationEditor, {
      initialDraft: draft,
      embedded: true,
      onSubmit: async () => undefined,
      onCancel: () => undefined,
    }),
    { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, stderr: new MockStdout() as unknown as NodeJS.WriteStream, alternateScreen: false, exitOnCtrlC: false, patchConsole: false },
  );
  await flush(application);
  await send(stdin, application, "\u001b[B"); // select Chat Completions path
  await send(stdin, application, "\u001b[H"); // Home
  await send(stdin, application, "X");
  await send(stdin, application, "\u001b[3~"); // Delete
  await send(stdin, application, "/edited");
  await send(stdin, application, "\u001b[F"); // End
  const rendered = outputOf(stdout);
  assert.match(rendered, /Chat Completions/);
  assert.match(rendered, /Chat Completions 路径：X/);
  application.unmount();
});

function InputHarness(): React.ReactElement {
  const [state, setState] = useState(createTuiInputBuffer());
  useInput((value, key) => {
    setState(current => reduceTuiInput(current, value, key).state);
  });
  return React.createElement(Text, null, `${state.text}|${state.cursor}`);
}

test("Mock TTY input harness remains live and accepts a paste payload", async () => {
  const stdin = new MockStdin();
  const stdout = new MockStdout();
  const application = render(React.createElement(InputHarness), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new MockStdout() as unknown as NodeJS.WriteStream,
    alternateScreen: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await flush(application);
  await send(stdin, application, "hello world");
  const rendered = outputOf(stdout);
  assert.match(rendered, /\|0|hello world/);
  application.unmount();
});

function MouseInputHarness({ onMouse }: { readonly onMouse: (event: string) => void }): React.ReactElement {
  const router = React.useMemo(
    () => new TuiInputRouter(event => {
      if (event.kind !== "mouse") return;
      const mouse = event.event;
      onMouse(mouse.kind === "wheel"
        ? `wheel:${mouse.direction}`
        : `${mouse.kind}:${mouse.button ?? "none"}`);
    }),
    [onMouse],
  );
  React.useEffect(() => () => router.reset(), [router]);
  useInput(value => {
    router.feed(value);
  });
  return React.createElement(Text, null, "ready");
}

test("Mock TTY routes SGR mouse reports through Ink useInput", async () => {
  const stdin = new MockStdin();
  const stdout = new MockStdout();
  const events: string[] = [];
  const application = render(React.createElement(MouseInputHarness, {
    onMouse: event => events.push(event),
  }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new MockStdout() as unknown as NodeJS.WriteStream,
    alternateScreen: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await flush(application);
  await send(stdin, application, "\u001b[<64;10;10M\u001b[<0;10;10M\u001b[<0;12;10m");
  assert.deepEqual(events, ["wheel:up", "press:left", "release:left"]);
  application.unmount();
});

test("configuration editor state remains valid after terminal resize", async () => {
  const state = createTuiConfigurationEditor(draft);
  assert.equal(state.horizontalWidth > 0, true);
  const stdout = new MockStdout();
  stdout.columns = 48;
  stdout.emit("resize");
  assert.equal(stdout.columns, 48);
});
