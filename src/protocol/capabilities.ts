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
  'files.stat',
  'files.mkdir',
  'files.copy',
  'files.move',
  'files.delete',
  'files.patch',
  'files.list',
  'search.text',
  'workspace.snapshot',
  'windows.processes',
  'windows.services',
  'windows.network.snapshot',
  'windows.service.control',
  'windows.registry.read',
  'windows.tasks',
  'windows.eventlog.query',
  'windows.firewall.rules',
] as const;

export type CoreCapability = (typeof CORE_CAPABILITIES)[number];
export type Capability = CoreCapability | (string & {});

export function hasCapability(
  capabilities: readonly string[],
  capability: string,
): boolean {
  return capabilities.includes(capability);
}

export function capabilitiesForPlatform(platform: NodeJS.Platform): string[] {
  return CORE_CAPABILITIES.filter((capability) => {
    if (capability.startsWith('windows.')) return platform === 'win32';
    if (capability === 'wsl.exec') return platform === 'win32';
    return true;
  });
}
