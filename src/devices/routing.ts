import type { ProviderTarget } from '../protocol/provider.js';
import type { DeviceRecord } from './directory.js';

export interface DeviceRoutingEntry {
  id: string;
  name: string;
  platform?: string;
  arch?: string;
  agentVersion?: string;
  online: boolean;
  capabilities: string[];
  aliases: string[];
  routes: Array<{
    providerId: string;
    online: boolean;
    capabilities: string[];
  }>;
  firstSeenAt?: string;
  lastSeenAt?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  connectionCount?: number;
}

export interface DeviceRouteFilter {
  deviceId?: string;
  platform?: string;
  nameContains?: string;
  requiredCapabilities?: string[];
  onlineOnly?: boolean;
}

export function buildDeviceRoutingEntries(input: {
  records: readonly DeviceRecord[];
  targets: readonly ProviderTarget[];
  aliasesByDevice?: ReadonlyMap<string, readonly string[]>;
}): DeviceRoutingEntry[] {
  const recordById = new Map(input.records.map((record) => [record.id, record]));
  const targetIds = new Set(input.targets.map((target) => target.id));
  const ids = new Set<string>([
    ...recordById.keys(),
    ...targetIds,
  ]);

  const entries: DeviceRoutingEntry[] = [];
  for (const id of ids) {
    const record = recordById.get(id);
    const routes = input.targets
      .filter((target) => target.id === id)
      .map((target) => ({
        providerId: target.providerId,
        online: target.online,
        capabilities: [...new Set(target.capabilities)].sort(),
      }))
      .sort(
        (a, b) =>
          Number(b.online) - Number(a.online) ||
          a.providerId.localeCompare(b.providerId),
      );
    const live = input.targets.find(
      (target) => target.id === id && target.online,
    );
    const anyTarget = live ?? input.targets.find((target) => target.id === id);
    const capabilities = [
      ...new Set(
        routes.flatMap((route) => route.capabilities).concat(
          record?.capabilities ?? [],
        ),
      ),
    ].sort();

    entries.push({
      id,
      name: live?.name ?? anyTarget?.name ?? record?.name ?? id,
      ...(live?.platform ?? anyTarget?.platform ?? record?.platform
        ? {
            platform:
              live?.platform ?? anyTarget?.platform ?? record?.platform,
          }
        : {}),
      ...(record?.arch ? { arch: record.arch } : {}),
      ...(record?.agentVersion
        ? { agentVersion: record.agentVersion }
        : {}),
      online: routes.some((route) => route.online),
      capabilities,
      aliases: [
        ...(input.aliasesByDevice?.get(id) ?? []),
      ].sort(),
      routes,
      ...(record
        ? {
            firstSeenAt: record.firstSeenAt,
            lastSeenAt: record.lastSeenAt,
            lastConnectedAt: record.lastConnectedAt,
            ...(record.lastDisconnectedAt
              ? { lastDisconnectedAt: record.lastDisconnectedAt }
              : {}),
            connectionCount: record.connectionCount,
          }
        : {}),
    });
  }

  return entries.sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '') ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

export function filterDeviceRoutes(
  devices: readonly DeviceRoutingEntry[],
  filter: DeviceRouteFilter,
): DeviceRoutingEntry[] {
  const required = [...new Set(filter.requiredCapabilities ?? [])];
  const platform = filter.platform?.trim().toLowerCase();
  const nameContains = filter.nameContains?.trim().toLowerCase();
  const onlineOnly = filter.onlineOnly ?? true;

  return devices.filter((device) => {
    if (filter.deviceId && device.id !== filter.deviceId) return false;
    if (onlineOnly && !device.online) return false;
    if (
      platform &&
      device.platform?.toLowerCase() !== platform
    ) {
      return false;
    }
    if (
      nameContains &&
      !device.name.toLowerCase().includes(nameContains) &&
      !device.aliases.some((alias) =>
        alias.toLowerCase().includes(nameContains),
      )
    ) {
      return false;
    }
    return required.every((capability) =>
      device.capabilities.includes(capability),
    );
  });
}
