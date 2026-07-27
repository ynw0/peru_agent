import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateReleaseGates, REQUIRED_PRODUCTION_GATES } from '../../dist/src/release/gates.js';

const inputPath = resolve(process.argv[2] ?? 'release/gate-results.json');
const outputPath = resolve(process.argv[3] ?? 'release/release-readiness.json');
const source = JSON.parse(await readFile(inputPath, 'utf8'));
if (!Array.isArray(source)) throw new Error('Release gate evidence must be an array.');
const result = evaluateReleaseGates(source);
const byName = new Map(source.map(item => [item.gate, item]));
const document = {
  schemaVersion: 1,
  productId: 'independent-ai-ide',
  productVersion: '0.13.0',
  generatedAt: process.env.SOURCE_DATE_EPOCH === undefined
    ? new Date().toISOString()
    : new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString(),
  ready: result.ready,
  blockers: result.blockers,
  gates: REQUIRED_PRODUCTION_GATES.map(gate => byName.get(gate) ?? { gate, passed: false, evidence: 'missing', completedAt: new Date(0).toISOString() }),
};
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(outputPath);
