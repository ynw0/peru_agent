import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const files = await collect(root, ['src/release', 'src/localization', 'packaging/windows', 'tools/release']);
const forbidden = [/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/, /child_process/, /\beval\s*\(/, /new Function\s*\(/];
for (const file of files) {
  if (file.endsWith('verify-source.mjs')) continue;
  const text = await readFile(file, 'utf8');
  for (const pattern of forbidden) {
    if (pattern.test(text)) throw new Error(`Release 源码包含禁止模式：${file} / ${pattern}`);
  }
}
const installer = await readFile(join(root, 'packaging/windows/install.ps1'), 'utf8');
for (const required of ['Get-AuthenticodeSignature', 'SignerCertificate', 'Thumbprint', 'Status -ne']) {
  if (!installer.includes(required)) throw new Error(`Windows 安装脚本缺少 Authenticode 门禁：${required}`);
}
const builder = await readFile(join(root, 'packaging/windows/build-release.ps1'), 'utf8');
for (const required of [String.raw`^v16\.14\.\d+$`, 'Yarn Classic 1.x', String.raw`node_modules\gulp\bin\gulp.js`, 'vscode-win32-$Architecture-min-ci', 'Get-AuthenticodeSignature', 'CertificateThumbprint', 'Remove-Item -LiteralPath $OutputDirectory']) {
  if (!builder.includes(required)) throw new Error(`Windows 发布构建脚本缺少门禁：${required}`);
}
if (builder.includes('--sign')) throw new Error('Windows 发布构建不能依赖未配置的上游 ESRP --sign 路径');
console.log(`Release 源码契约检查通过：${files.length} 个文件`);

async function collect(base, roots) {
  const output = [];
  for (const relative of roots) await walk(join(base, relative), output);
  return output;
}
async function walk(directory, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else if (entry.isFile()) output.push(path);
  }
}
