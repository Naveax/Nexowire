export type PrivilegeRequirement = 'standard' | 'elevated';

function record(input: unknown): Record<string, unknown> {
  return typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function privilegeRequirement(
  capability: string,
  input: unknown,
): PrivilegeRequirement {
  switch (capability) {
    case 'windows.service.control':
    case 'windows.task.control':
    case 'windows.firewall.control':
    case 'nexowire.machine_update.apply':
    case 'windows.installer.preflight':
    case 'windows.installer.apply':
    case 'windows.installer.status':
      return 'elevated';

    case 'windows.registry.set':
    case 'windows.registry.delete': {
      const hive = record(input).hive;
      return hive === 'HKCU' ? 'standard' : 'elevated';
    }

    case 'windows.environment.set':
    case 'windows.environment.delete':
      return record(input).scope === 'machine'
        ? 'elevated'
        : 'standard';

    default:
      return 'standard';
  }
}

export function isPrivilegedBrokerCapability(
  capability: string,
): boolean {
  return [
    'windows.service.control',
    'windows.registry.set',
    'windows.registry.delete',
    'windows.task.control',
    'windows.firewall.control',
    'windows.environment.set',
    'windows.environment.delete',
    'nexowire.machine_update.apply',
    'windows.installer.preflight',
    'windows.installer.apply',
    'windows.installer.status',
  ].includes(capability);
}
