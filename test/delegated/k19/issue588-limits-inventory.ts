/** Read-only inventory of #588 transfer limits; no production modules are executed. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LIMIT_SOURCE_PATHS = {
  mcpRegistration: 'src/mcp/create-server.ts',
  directTransfer: 'src/mcp/cross-device-file-transfer.ts',
  deviceIngest: 'src/mcp/artifact-bridge-device-ingest.ts',
  artifactStore: 'src/workspace/artifact-bridge.ts',
} as const;

export type LimitSource = keyof typeof LIMIT_SOURCE_PATHS;
export type LimitSources = Record<LimitSource, string>;

function matchUnique(source: string, label: string, pattern: RegExp): string {
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))];
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new Error(`${label}: expected exactly one matching implementation bound, found ${matches.length}`);
  }
  return matches[0][1];
}

function literal(value: string, label: string): number {
  // The source constants here are integer expressions; never evaluate arbitrary TS text.
  if (!/^\d[\d_]*(?:\s*\*\s*\d[\d_]*)*$/.test(value)) {
    throw new Error(`${label}: unsupported numeric expression`);
  }
  const result = value.split('*').reduce((acc, term) => acc * Number(term.replaceAll('_', '').trim()), 1);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${label}: invalid integer bound`);
  }
  return result;
}

function bound(source: string, label: string, pattern: RegExp): number {
  return literal(matchUnique(source, label, pattern), label);
}

function section(source: string, begin: string, end: string, label: string): string {
  const from = source.indexOf(begin);
  const to = from < 0 ? -1 : source.indexOf(end, from + begin.length);
  if (from < 0 || to < 0 || source.indexOf(begin, from + begin.length) !== -1) {
    throw new Error(`${label}: could not isolate unique source section`);
  }
  return source.slice(from, to);
}

export interface Issue588SourceLimits {
  schemaVersion: 1;
  directMcpMaxBytes: number;
  directHelperMaxBytes: number;
  directChunkBytes: number;
  artifactIngestMaxBytes: number;
  artifactIngestChunkBytes: number;
  artifactIngestMaxChunksPerCall: number;
  artifactManifestMaxBytes: number;
  artifactManifestChunkMaxBytes: number;
  artifactManifestMaxChunks: number;
}

export function parseIssue588SourceLimits(sources: LimitSources): Issue588SourceLimits {
  const tool = section(sources.mcpRegistration,
    "'file_transfer_between_devices',", "server.registerTool(", 'file_transfer_between_devices');
  const manifest = section(sources.artifactStore,
    'const manifestSchema = z.object({', 'const chunkSchema = z.object({', 'artifact manifest');
  const chunk = section(sources.artifactStore,
    'const chunkSchema = z.object({', 'const sessionSchema = z.object({', 'artifact chunk');
  const session = section(sources.artifactStore,
    'const sessionSchema = z.object({', 'const lockSchema = z.object({', 'artifact session');
  return {
    schemaVersion: 1,
    directMcpMaxBytes: bound(tool, 'MCP file_transfer max_bytes',
      /max_bytes:\s*z\.number\(\)\.int\(\)\.min\(1\)\.max\((\d[\d_]*)\)\.optional\(\)/),
    directHelperMaxBytes: bound(sources.directTransfer, 'cross-device helper maximum',
      /export const CROSS_DEVICE_MAX_BYTES\s*=\s*(\d[\d_]*(?:\s*\*\s*\d[\d_]*)*)\s*;/),
    directChunkBytes: bound(sources.directTransfer, 'cross-device default chunk',
      /export const CROSS_DEVICE_CHUNK_BYTES\s*=\s*(\d[\d_]*(?:\s*\*\s*\d[\d_]*)*)\s*;/),
    artifactIngestMaxBytes: bound(sources.deviceIngest, 'device ingest file maximum',
      /stat\.size\s*>\s*(\d[\d_]*)\s*\)\s*\{/),
    artifactIngestChunkBytes: bound(sources.deviceIngest, 'device ingest chunk',
      /const size\s*=\s*Math\.min\((\d[\d_]*),\s*stat\.size\s*-\s*offset\)/),
    artifactIngestMaxChunksPerCall: bound(sources.deviceIngest, 'device ingest per-call maximum',
      /maxChunks\s*>\s*(\d[\d_]*)\s*\)\s*\{/),
    artifactManifestMaxBytes: bound(manifest, 'artifact manifest file maximum',
      /size:\s*z\.number\(\)\.int\(\)\.min\(0\)\.max\((\d[\d_]*)\)/),
    artifactManifestChunkMaxBytes: bound(chunk, 'artifact manifest chunk maximum',
      /size:\s*z\.number\(\)\.int\(\)\.min\(1\)\.max\((\d[\d_]*)\)/),
    artifactManifestMaxChunks: bound(session, 'artifact manifest chunk count',
      /chunks:\s*z\.array\(chunkSchema\)\.max\((\d[\d_]*)\)/),
  };
}

export async function readIssue588SourceLimits(root: string): Promise<Issue588SourceLimits> {
  const keys = Object.keys(LIMIT_SOURCE_PATHS) as LimitSource[];
  const entries = await Promise.all(keys.map(async key => [key,
    await readFile(join(root, LIMIT_SOURCE_PATHS[key]), 'utf8')] as const));
  return parseIssue588SourceLimits(Object.fromEntries(entries) as LimitSources);
}
