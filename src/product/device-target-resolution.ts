// Pure, owner-scoped routing: caller must supply only authenticated owner's devices.
export interface RoutableDevice {
  id: string;
  name: string;
  online: boolean;
  folderId: string | null;
}
export interface RoutableFolder { id: string; name: string }

export interface DeviceTargetQuery {
  deviceId?: string;
  deviceName?: string;
  folderId?: string;
  folderName?: string;
}
export type TargetResolution =
  | {
      status: 'selected';
      reason: 'explicit-device' | 'one-in-folder' | 'only-device';
      device: RoutableDevice;
    }
  | {
      status: 'selection_required';
      reason: 'ambiguous-device' | 'ambiguous-folder' | 'multiple-devices' | 'explicit-selection-required';
      devices: RoutableDevice[];
      folders: RoutableFolder[];
    }
  | {
      status: 'empty_folder' | 'no_devices';
      devices: RoutableDevice[];
      folders: RoutableFolder[];
    };

function normalized(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

export function resolveOwnerDeviceTarget(
  devices: readonly RoutableDevice[],
  folders: readonly RoutableFolder[],
  query: DeviceTargetQuery = {},
  allowImplicitSelection = false,
): TargetResolution {
  const orderedDevices = [...devices].sort((a, b) =>
    a.name.localeCompare(b.name, 'tr-TR') || a.id.localeCompare(b.id));
  const orderedFolders = [...folders].sort((a, b) =>
    a.name.localeCompare(b.name, 'tr-TR') || a.id.localeCompare(b.id));
  const choices = (
    reason: 'ambiguous-device' | 'ambiguous-folder' | 'multiple-devices' | 'explicit-selection-required',
    candidates: RoutableDevice[] = orderedDevices,
  ): TargetResolution => ({
    status: 'selection_required', reason, devices: candidates, folders: orderedFolders,
  });

  let folder: RoutableFolder | undefined;
  if (query.folderId !== undefined || query.folderName !== undefined) {
    const matches = orderedFolders.filter(item =>
      (query.folderId === undefined || item.id === query.folderId) &&
      (query.folderName === undefined || normalized(item.name) === normalized(query.folderName)));
    if (matches.length === 0) throw new Error('FOLDER_NOT_FOUND');
    if (matches.length > 1) return choices('ambiguous-folder');
    folder = matches[0];
  }

  const scopedDevices = folder
    ? orderedDevices.filter(device => device.folderId === folder.id)
    : orderedDevices;
  if (query.deviceId !== undefined || query.deviceName !== undefined) {
    const matches = scopedDevices.filter(item =>
      (query.deviceId === undefined || item.id === query.deviceId) &&
      (query.deviceName === undefined || normalized(item.name) === normalized(query.deviceName)));
    if (matches.length === 0) throw new Error('DEVICE_NOT_FOUND');
    if (matches.length > 1) return choices('ambiguous-device', scopedDevices);
    return {status:'selected', reason:'explicit-device', device: matches[0]!};
  }
  if (!scopedDevices.length) return {
    status: folder ? 'empty_folder' : 'no_devices',
    devices: scopedDevices, folders: orderedFolders,
  };
  if (scopedDevices.length === 1 && !allowImplicitSelection) {
    return choices('explicit-selection-required', scopedDevices);
  }
  if (scopedDevices.length === 1) return {
    status:'selected', reason: folder ? 'one-in-folder' : 'only-device',
    device: scopedDevices[0]!,
  };
  return choices('multiple-devices', scopedDevices);
}
