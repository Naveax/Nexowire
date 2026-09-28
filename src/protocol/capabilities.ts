export const CORE_CAPABILITIES = [
  'machine.snapshot',
  'shell.exec',
  'process.start',
  'process.read',
  'process.write',
  'process.stop',
  'process.list',
  'wsl.exec',
  'files.read',
  'files.read_many',
  'files.write',
  'files.list',
  'search.text',
  'workspace.snapshot',
] as const;

export type CoreCapability = (typeof CORE_CAPABILITIES)[number];
export type Capability = CoreCapability | (string & {});

export function hasCapability(
  capabilities: readonly string[],
  capability: string,
): boolean {
  return capabilities.includes(capability);
}
