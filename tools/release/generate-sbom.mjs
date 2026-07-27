import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const packagePath = resolve(process.argv[2] ?? 'package.json');
const outputPath = resolve(process.argv[3] ?? 'release/sbom.spdx.json');
const created = process.env.SOURCE_DATE_EPOCH === undefined
  ? new Date().toISOString()
  : new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString();
const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
const packages = [];
for (const [relationship, dependencies] of [['RUNTIME_DEPENDENCY_OF', pkg.dependencies ?? {}], ['DEV_DEPENDENCY_OF', pkg.devDependencies ?? {}]]) {
  for (const [name, versionInfo] of Object.entries(dependencies)) packages.push({ SPDXID: `SPDXRef-Package-${name.replace(/[^a-zA-Z0-9.-]/g, '-')}-${relationship}`, name, versionInfo, relationship });
}
packages.sort((a, b) => a.name.localeCompare(b.name) || a.relationship.localeCompare(b.relationship));
const identity = createHash('sha256').update(JSON.stringify({ name: pkg.name, version: pkg.version, packages })).digest('hex');
const sbom = { spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: `${pkg.name}-${pkg.version}`, documentNamespace: `https://independent-ai-ide.invalid/sbom/${identity}`, creationInfo: { created, creators: ['Tool: Independent AI IDE Release Pipeline'] }, packages };
await writeFile(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
console.log(outputPath);
