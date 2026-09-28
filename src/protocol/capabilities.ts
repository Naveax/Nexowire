export const CORE_CAPABILITIES = [
  'machine.snapshot',
  'shell.exec',
  'wsl.exec',
  'files.read',
  'files.write',
  'files.list',
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
