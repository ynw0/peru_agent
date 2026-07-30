/*---------------------------------------------------------------------------------------------
 * Main-process facade for the bundled, independent AI Runtime child process.
 * Electron Main never imports the ESM Agent Host; it only speaks NDJSON over stdio.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Emitter, Event } from 'vs/base/common/event';
import { IServerChannel } from 'vs/base/parts/ipc/common/ipc';
import { join } from 'vs/base/common/path';
import * as readline from 'readline';

interface RuntimeMessage { readonly version: 1; readonly type: 'response' | 'event'; readonly id?: string; readonly ok?: boolean; readonly result?: unknown; readonly error?: { readonly code: string; readonly message: string }; readonly event?: string; readonly data?: unknown; }
interface Pending { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; }

const PROTOCOL_VERSION = 1 as const;
const MAX_LINE_LENGTH = 8 * 1024 * 1024;

export class IndependentAiIdeRuntimeChannel implements IServerChannel {
  private readonly onSnapshotEmitter = new Emitter<unknown>();
  private readonly pending = new Map<string, Pending>();
  private process: ChildProcessWithoutNullStreams | undefined;
  private sequence = 0;
  private initialized = false;

  constructor(private readonly dataDirectory: string) {}

  listen<T>(_context: string, event: string, _arg?: unknown): Event<T> {
    if (event === 'snapshot') return this.onSnapshotEmitter.event as Event<T>;
    throw new Error(`不支持的 AI Runtime 事件：${event}`);
  }

  async call<T>(_context: string, command: string, arg?: unknown): Promise<T> {
    if (command === 'initialize') {
      const model = arg ?? {};
      const result = await this.request('runtime.initialize', { model }) as { readonly snapshot: unknown };
      this.initialized = true;
      return result.snapshot as T;
    }
    if (!this.initialized && command !== 'getSnapshot') throw new Error('AI Runtime 尚未初始化');
    const mapped: Record<string, string> = {
      getSnapshot: 'runtime.getSnapshot', sendInput: 'agent.sendInput', stop: 'agent.stop', retry: 'agent.retry',
      resolvePermission: 'permission.resolve', resolvePlan: 'plan.resolve', acceptDiff: 'diff.accept', rejectDiff: 'diff.reject', restoreCheckpoint: 'checkpoint.restore',
    };
    const runtimeCommand = mapped[command];
    if (runtimeCommand === undefined) throw new Error(`不支持的 AI Runtime 命令：${command}`);
    return await this.request(runtimeCommand, arg) as T;
  }

  dispose(): void {
    if (this.process !== undefined) {
      void this.request('runtime.shutdown', {}).catch(() => undefined);
      this.process.kill();
      this.process = undefined;
    }
    for (const pending of this.pending.values()) pending.reject(new Error('AI Runtime 已退出'));
    this.pending.clear();
    this.onSnapshotEmitter.dispose();
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process !== undefined) return this.process;
    const runtimeDirectory = join(process.resourcesPath, 'app', 'ai-runtime');
    const nodePath = join(runtimeDirectory, 'node.exe');
    const entryPath = join(runtimeDirectory, 'src', 'desktop', 'runtime-entry.js');
    const brokerPath = join(process.resourcesPath, 'app', 'bin', 'windows-sandbox-broker', 'IndependentAiIde.WindowsSandboxBroker.exe');
    if (!existsSync(nodePath)) throw new Error(`内置 Runtime Node 不存在：${nodePath}`);
    if (!existsSync(entryPath)) throw new Error(`Runtime 入口不存在：${entryPath}`);
    if (!existsSync(brokerPath)) throw new Error(`Windows Sandbox Broker 不存在：${brokerPath}`);
    const child = spawn(nodePath, [entryPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { INDEPENDENT_AI_IDE_DATA_DIRECTORY: this.dataDirectory, INDEPENDENT_AI_IDE_SANDBOX_BROKER: brokerPath } });
    this.process = child;
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => this.handleLine(line));
    child.stderr.on('data', data => console.error(`[Independent AI IDE Runtime] ${String(data).trimEnd()}`));
    child.on('error', error => this.failAll(error));
    child.on('exit', () => this.failAll(new Error('AI Runtime 进程已退出')));
    return child;
  }

  private request(command: string, args: unknown): Promise<unknown> {
    const child = this.ensureProcess();
    const id = `runtime-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ version: PROTOCOL_VERSION, type: 'request', id, command, arguments: args })}\n`, 'utf8');
    });
  }

  private handleLine(line: string): void {
    if (line.length > MAX_LINE_LENGTH) { this.failAll(new Error('Runtime IPC 消息超过最大长度')); return; }
    let message: RuntimeMessage;
    try { message = JSON.parse(line) as RuntimeMessage; } catch { this.failAll(new Error('Runtime IPC 收到非法 JSON')); return; }
    if (message.type === 'event' && message.event === 'workbench.snapshot') { this.onSnapshotEmitter.fire(message.data); return; }
    if (message.type !== 'response' || message.id === undefined) return;
    const pending = this.pending.get(message.id); if (pending === undefined) return;
    this.pending.delete(message.id);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(new Error(message.error?.message ?? 'Runtime 请求失败'));
  }

  private failAll(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); this.process = undefined; }
}
